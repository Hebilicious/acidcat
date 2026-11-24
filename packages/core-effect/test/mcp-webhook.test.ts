import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { isJsonObject, webhookSignature, webhookSubscriptionId } from "@acid-cat/spec-ts";
import { Effect, Layer, Option, Schedule, Schema, Stream } from "effect";

import { App, Event, Mcp } from "../src/index.ts";
import * as NodeWebhook from "../src/NodeWebhook.ts";
import { events, Feed, feedForPromises } from "./events-fixture.ts";
import { eventually, json, mcpRequest, ORIGIN } from "./mcp-client.ts";
import { agree, startReceiver, testSigningKey } from "./webhook-receiver.ts";
import type { Received } from "./webhook-receiver.ts";

const SECRET = `whsec_${Buffer.from("a".repeat(32)).toString("base64")}`;
const NEW_SECRET = `whsec_${Buffer.from("b".repeat(32)).toString("base64")}`;

const SubscribeResult = Schema.Struct({
  resultType: Schema.Literal("complete"),
  id: Schema.String,
  refreshBefore: Schema.String,
  cursor: Schema.NullOr(Schema.String),
  truncated: Schema.Literal(false),
  deliveryStatus: Schema.Struct({ active: Schema.Literal(true), lastDeliveryAt: Schema.NullOr(Schema.String), lastError: Schema.NullOr(Schema.String) }),
});
const decodeSubscribeResult = Schema.decodeUnknownSync(SubscribeResult);

let receiver: Awaited<ReturnType<typeof startReceiver>>;
before(async () => {
  receiver = await startReceiver();
});
after(async () => {
  await receiver.close();
});

function webhookOptions(webhooks: Partial<Mcp.WebhookOptions> = {}) {
  return {
    name: "feed",
    version: "0.0.0",
    allowedOrigins: [ORIGIN],
    principal: (request: Request) => Effect.succeed(Option.fromNullOr(request.headers.get("X-User"))),
    webhooks: {
      sender: NodeWebhook.sender({ allowPrivateNetworks: true, ca: receiver.cert }),
      retryDelays: Schedule.spaced("20 millis"),
      ...webhooks,
    },
  };
}

function webhookHandler(feed: ReturnType<typeof feedForPromises>, webhooks: Partial<Mcp.WebhookOptions> = {}) {
  return Mcp.toWebHandler(events, feed.layer, webhookOptions(webhooks));
}

const as = (user: string) => ({ headers: { "X-User": user } });

const subscription = (path: string, extra: Record<string, unknown> = {}) => ({
  name: "feed.ticked",
  arguments: { room: path },
  delivery: { mode: "webhook", url: receiver.url(path), secret: SECRET },
  ...extra,
});

const at = (path: string) => receiver.received.filter((each) => each.path === path);

async function waitAt(path: string, count: number): Promise<readonly Received[]> {
  while (at(path).length < count) await receiver.next();
  return at(path);
}

async function assertSigned(received: Received, secrets: readonly string[], subscriptionId: string) {
  const id = received.headers["webhook-id"] ?? "";
  const timestamp = Number(received.headers["webhook-timestamp"]);
  assert.equal(received.headers["content-type"], "application/json");
  assert.equal(received.headers["x-mcp-subscription-id"], subscriptionId);
  assert.ok(Math.abs(timestamp - Date.now() / 1000) < 60);
  assert.equal(received.headers["webhook-signature"], await webhookSignature(secrets, id, timestamp, received.body));
}

const bodyOf = (received: Received | undefined) => (received !== undefined && isJsonObject(received.json) ? received.json : {});

test("a secret over 64 bytes, or an event outside the target, is refused before the server sends a request", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed);
  try {
    const long = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/long"), delivery: { mode: "webhook", url: receiver.url("/long"), secret: `whsec_${Buffer.from("x".repeat(65)).toString("base64")}` } }, as("alice"))));
    assert.equal(long.error?.code, -32602);
    const hidden = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/hidden"), name: "feed.hidden" }, as("alice"))));
    assert.equal(hidden.error?.code, -32023);
    assert.equal(at("/long").length + at("/hidden").length, 0);
  } finally {
    await handler.dispose();
  }
});

test("events/stream, events/poll and events/subscribe check the name before maxAgeMs, and a renewal checks maxAgeMs too", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed, { allow: () => true });
  try {
    const params = { stream: {}, poll: {}, subscribe: subscription("/order") };
    for (const [mode, extra] of Object.entries(params)) {
      for (const maxAgeMs of [-1, 1.5, "60"]) {
        const unknown = await json(await handler(mcpRequest(`events/${mode}`, { ...extra, name: "no.such", maxAgeMs }, as("alice"))));
        assert.deepEqual([unknown.error?.code, unknown.error?.data], [-32023, { kind: "event" }], `${mode} with maxAgeMs ${maxAgeMs}`);
        const invalid = await json(await handler(mcpRequest(`events/${mode}`, { ...extra, name: "feed.resumed", maxAgeMs }, as("alice"))));
        assert.equal(invalid.error?.code, -32602, `${mode} with maxAgeMs ${maxAgeMs}`);
      }
    }
    const started = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/order"), maxAgeMs: null }, as("alice"))));
    assert.equal(started.error, undefined);
    const renewed = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/order"), maxAgeMs: -1 }, as("alice"))));
    assert.equal(renewed.error?.code, -32602);
  } finally {
    await handler.dispose();
  }
});

test("a new subscription has the id of its key, no cursor, an empty delivery status and the default lifetime, and another principal verifies the URL again", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed);
  try {
    const result = decodeSubscribeResult((await json(await handler(mcpRequest("events/subscribe", subscription("/hooks"), as("alice"))))).result);
    const id = await webhookSubscriptionId("alice", receiver.url("/hooks"), "feed.ticked", { room: "/hooks" });
    assert.deepEqual({ ...result, refreshBefore: "" }, { resultType: "complete", id, refreshBefore: "", cursor: null, truncated: false, deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null } });
    const lifetime = Date.parse(result.refreshBefore) - Date.now();
    assert.ok(lifetime > 3_590_000 && lifetime <= 3_600_000, `${lifetime}`);
    assert.equal(at("/hooks").length, 1);
    await json(await handler(mcpRequest("events/subscribe", subscription("/hooks"), as("bob"))));
    assert.deepEqual(at("/hooks").map((each) => bodyOf(each).type), ["verification", "verification"]);
  } finally {
    await handler.dispose();
  }
  await feed.following(0);
});

test("a verification that gets 3xx is challenge_failed, 4xx is http_4xx and 5xx is http_5xx", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed);
  try {
    const statuses: Record<string, number> = { "/moved": 302, "/gone": 404, "/down": 503 };
    receiver.respond((received) => ({ status: statuses[received.path] ?? 200 }));
    const reasons: Record<string, unknown> = {};
    for (const path of Object.keys(statuses)) reasons[path] = (await json(await handler(mcpRequest("events/subscribe", subscription(path), as("alice"))))).error?.data;
    assert.deepEqual(reasons, { "/moved": { reason: "challenge_failed" }, "/gone": { reason: "http_4xx" }, "/down": { reason: "http_5xx" } });
    await feed.following(0);
  } finally {
    receiver.respond(agree);
    await handler.dispose();
  }
});

test("a URL that the deployment allows needs no verification", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed, { allow: (url) => url.pathname === "/allowed" });
  try {
    const answer = await json(await handler(mcpRequest("events/subscribe", subscription("/allowed"), as("alice"))));
    decodeSubscribeResult(answer.result);
    await feed.following(1);
    await feed.publish({ room: "/allowed", count: 1 });
    const [first] = await waitAt("/allowed", 1);
    assert.equal(bodyOf(first).name, "feed.ticked");
  } finally {
    await handler.dispose();
  }
});

const statusOf = async (handler: Mcp.WebHandler, path: string) => decodeSubscribeResult((await json(await handler(mcpRequest("events/subscribe", subscription(path), as("alice"))))).result);

test("a 410 abandons a delivery with no retry and the delivery status tells it, and the next success clears the error", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed);
  try {
    receiver.respond((received) => (received.path === "/retry" && bodyOf(received).cursor === "1" ? { status: 410 } : agree(received)));
    await statusOf(handler, "/retry");
    await feed.following(1);
    await feed.publish({ room: "/retry", count: 1 });
    const abandoned = await eventually(() => statusOf(handler, "/retry"), (status) => status.cursor === "1");
    assert.equal(abandoned.deliveryStatus.lastError, "http_4xx");
    await feed.publish({ room: "/retry", count: 2 });
    const [, , next] = await waitAt("/retry", 3);
    assert.equal(bodyOf(next).cursor, "2");
    const healthy = await eventually(() => statusOf(handler, "/retry"), (status) => status.cursor === "2");
    assert.equal(healthy.deliveryStatus.lastError, null);
    assert.notEqual(healthy.deliveryStatus.lastDeliveryAt, null);
  } finally {
    receiver.respond(agree);
    await handler.dispose();
  }
});

test("a delivery that fails each time is abandoned after the maximum number of attempts", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed, { attempts: 3 });
  try {
    receiver.respond((received) => (received.path === "/failing" && bodyOf(received).cursor === "1" ? { status: 500 } : agree(received)));
    await statusOf(handler, "/failing");
    await feed.following(1);
    await feed.publish({ room: "/failing", count: 1 });
    const failed = await eventually(() => statusOf(handler, "/failing"), (status) => status.deliveryStatus.lastError !== null);
    assert.equal(failed.deliveryStatus.lastError, "http_5xx");
    await feed.publish({ room: "/failing", count: 2 });
    const requests = await waitAt("/failing", 5);
    assert.deepEqual(requests.map((each) => bodyOf(each).type ?? bodyOf(each).cursor), ["verification", "1", "1", "1", "2"]);
  } finally {
    receiver.respond(agree);
    await handler.dispose();
  }
});

test("a gap message comes before an occurrence with truncated: true", async () => {
  const more = Promise.withResolvers<void>();
  const buffered = Promise.withResolvers<void>();
  const counts = Event.make({
    id: "burst.counted",
    description: "Give the count 1, then the counts 2 to 4 when the test asks for them, with the count as the cursor.",
    audience: ["mcp"],
    payload: Schema.Struct({ count: Schema.Int }),
    subscribe: () =>
      Stream.make(1).pipe(
        Stream.concat(Stream.fromEffect(Effect.promise(() => more.promise)).pipe(Stream.flatMap(() => Stream.make(2, 3, 4)))),
        Stream.concat(Stream.fromEffect(Effect.sync(() => buffered.resolve())).pipe(Stream.drain)),
        Stream.map((count) => ({ data: { count }, cursor: String(count) })),
      ),
  });
  const app = App.make({ targets: { mcp: { surfaces: ["mcp"] } }, capabilities: [], events: [counts] });
  const handler = Mcp.toWebHandler(app, Layer.empty, { ...webhookOptions(), eventBuffer: 1 });
  const held = Promise.withResolvers<void>();
  try {
    receiver.respond(async (received) => {
      if (received.path === "/gap" && bodyOf(received).cursor === "1") await held.promise;
      return agree(received);
    });
    await json(await handler(mcpRequest("events/subscribe", { name: "burst.counted", arguments: {}, delivery: { mode: "webhook", url: receiver.url("/gap"), secret: SECRET } }, as("alice"))));
    await waitAt("/gap", 2);
    more.resolve();
    await buffered.promise;
    held.resolve();
    const [, , gap, next] = await waitAt("/gap", 4);
    assert.deepEqual(bodyOf(gap), { type: "gap", cursor: "1" });
    assert.match(gap?.headers["webhook-id"] ?? "", /^msg_gap_[A-Za-z0-9]+$/);
    assert.equal(bodyOf(next).cursor, "4");
    assert.equal("truncated" in bodyOf(next), false);
  } finally {
    held.resolve();
    receiver.respond(agree);
    await handler.dispose();
  }
});

test("after the grace time of a renewal, only the new secret signs", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed, { rotationGraceMs: 0 });
  try {
    const first = await statusOf(handler, "/rotate");
    await feed.following(1);
    await json(await handler(mcpRequest("events/subscribe", { ...subscription("/rotate"), delivery: { mode: "webhook", url: receiver.url("/rotate"), secret: NEW_SECRET } }, as("alice"))));
    await feed.publish({ room: "/rotate", count: 1 });
    const [, single] = await waitAt("/rotate", 2);
    assert.ok(single);
    assert.equal(single.headers["webhook-signature"]?.split(" ").length, 1);
    await assertSigned(single, [NEW_SECRET], first.id);
  } finally {
    await handler.dispose();
  }
});

const discoveringServer = async (request: Request) => {
  const message: unknown = await request.json();
  const id = isJsonObject(message) ? message.id : null;
  return Response.json({ jsonrpc: "2.0", id, result: { supportedVersions: ["2026-07-28"], capabilities: {}, _meta: { "io.modelcontextprotocol/serverInfo": { name: "feed", version: "0.0.0" } } } });
};

test("withEvents: with signing keys, each webhook request has a v1a signature for each key after the v1 signature, which the keys of the Server Card verify", async () => {
  const feed = feedForPromises();
  const egressIpRanges = ["203.0.113.0/24", "2001:db8::/32"];
  const path = "/signed";
  const handler = Mcp.withEvents(events, feed.layer, discoveringServer, webhookOptions({ signingKeys: [testSigningKey("first"), testSigningKey("second")], egressIpRanges }));
  try {
    await statusOf(handler, path);
    await feed.following(1);
    await feed.publish({ room: path, count: 1 });
    const requests = await waitAt(path, 2);
    const card: unknown = await (await handler(new Request(`${ORIGIN}/mcp/server-card`))).json();
    const remotes = isJsonObject(card) ? card.remotes : undefined;
    const extensions = Array.isArray(remotes) && isJsonObject(remotes[0]) ? remotes[0].extensionsInfo : undefined;
    const events = isJsonObject(extensions) ? extensions["io.modelcontextprotocol/events"] : undefined;
    const webhooks = isJsonObject(events) && isJsonObject(events.webhooks) ? events.webhooks : {};
    assert.deepEqual(webhooks.egressIpRanges, egressIpRanges);
    const keys = isJsonObject(webhooks.signingKeys) && Array.isArray(webhooks.signingKeys.keys) ? webhooks.signingKeys.keys : [];
    assert.deepEqual(
      keys.map((key: unknown) => (isJsonObject(key) ? [key.kid, Object.keys(key).sort()] : undefined)),
      [["first", ["crv", "kid", "kty", "x"]], ["second", ["crv", "kid", "kty", "x"]]],
    );
    for (const received of requests) {
      const id = received.headers["webhook-id"] ?? "";
      const timestamp = Number(received.headers["webhook-timestamp"]);
      const [hmac, ...asymmetric] = (received.headers["webhook-signature"] ?? "").split(" ");
      assert.equal(hmac, await webhookSignature([SECRET], id, timestamp, received.body));
      assert.equal(asymmetric.length, keys.length);
      for (const [index, signature] of asymmetric.entries()) {
        const jwk: unknown = keys[index];
        assert.ok(isJsonObject(jwk) && typeof jwk.x === "string" && signature.startsWith("v1a,"));
        const publicKey = await crypto.subtle.importKey("jwk", { kty: "OKP", crv: "Ed25519", x: jwk.x }, "Ed25519", false, ["verify"]);
        assert.ok(await crypto.subtle.verify("Ed25519", publicKey, Buffer.from(signature.slice(4), "base64"), new TextEncoder().encode(`${id}.${timestamp}.${received.body}`)));
      }
    }
  } finally {
    await handler.dispose();
  }
});

test("a signing key of another form, two keys with the same kid, or an egress range that is not CIDR text, make the server fail when it starts", () => {
  const feed = feedForPromises();
  const key = testSigningKey("same");
  const starts = (webhooks: Partial<Mcp.WebhookOptions>) => () => Mcp.toWebHandler(events, feed.layer, webhookOptions(webhooks));
  assert.throws(starts({ signingKeys: [{ ...key, d: "short" }] }), /Signing key 0/);
  assert.throws(starts({ signingKeys: [key, { ...testSigningKey("other"), kid: "same" }] }), /same/);
  for (const range of ["10.0.0.0/33", "10.0.0.0", "bad/8", "2001:db8::/129"]) assert.throws(starts({ egressIpRanges: [range] }), /CIDR/, range);
});

test("events/unsubscribe of another principal does not find the subscription", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed);
  try {
    await json(await handler(mcpRequest("events/subscribe", subscription("/end"), as("alice"))));
    const missing = await json(await handler(mcpRequest("events/unsubscribe", { name: "feed.ticked", arguments: { room: "/end" }, delivery: { url: receiver.url("/end") } }, as("bob"))));
    assert.deepEqual([missing.error?.code, missing.error?.data], [-32023, { kind: "subscription" }]);
  } finally {
    await handler.dispose();
  }
  await feed.following(0);
});

test("a subscription ends after its terminated message", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed);
  try {
    await json(await handler(mcpRequest("events/subscribe", { ...subscription("/crash"), name: "feed.crashing", arguments: {} }, as("alice"))));
    const [, , terminated] = await waitAt("/crash", 3);
    assert.equal(bodyOf(terminated).type, "terminated");
    const missing = await eventually(
      async () => json(await handler(mcpRequest("events/unsubscribe", { name: "feed.crashing", arguments: {}, delivery: { url: receiver.url("/crash") } }, as("alice")))),
      (answer) => answer.error !== undefined,
    );
    assert.equal(missing.error?.code, -32023);
  } finally {
    await handler.dispose();
  }
});

test("with per-request services, a webhook subscription keeps the services of its request until it ends", async () => {
  const feed = feedForPromises();
  const counts = { built: 0, released: 0 };
  const layer = Layer.effect(
    Feed,
    Effect.acquireRelease(
      Effect.andThen(
        Effect.sync(() => counts.built++),
        Effect.service(Feed),
      ),
      () => Effect.sync(() => counts.released++),
    ),
  ).pipe(Layer.provide(feed.layer));
  const handler = Mcp.toWebHandler(events, layer, { ...webhookOptions(), services: "per-request" });
  try {
    await json(await handler(mcpRequest("events/subscribe", subscription("/services"), as("alice"))));
    await feed.following(1);
    assert.deepEqual(counts, { built: 1, released: 0 });
    await json(await handler(mcpRequest("events/unsubscribe", { name: "feed.ticked", arguments: { room: "/services" }, delivery: { url: receiver.url("/services") } }, as("alice"))));
    await feed.following(0);
    await eventually(async () => counts.released, (released) => released === 2);
    assert.equal(counts.built, 2);
  } finally {
    await handler.dispose();
  }
});

test("parallel new subscriptions of one principal cannot pass the limit together", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed, { maxSubscriptions: 2 });
  try {
    const answers = await Promise.all(
      ["a", "b", "c", "d"].map(async (room) => json(await handler(mcpRequest("events/subscribe", subscription(`/parallel-${room}`), as("erin"))))),
    );
    assert.equal(answers.filter((answer) => answer.error === undefined).length, 2);
    assert.equal(answers.filter((answer) => answer.error?.code === -32025).length, 2);
  } finally {
    await handler.dispose();
  }
});

test("the verification is for the pair of the principal and the URL as the client sent it", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed);
  try {
    const verifications = () => at("/spelled").filter((each) => isJsonObject(each.json) && each.json.type === "verification").length;
    const spelled = { ...subscription("/spelled"), delivery: { ...subscription("/spelled").delivery, url: receiver.url("/spelled").replace("https://", "HTTPS://") } };
    for (const params of [subscription("/spelled"), { ...subscription("/spelled"), arguments: { room: "again" } }, spelled]) {
      decodeSubscribeResult((await json(await handler(mcpRequest("events/subscribe", params, as("frank"))))).result);
    }
    assert.equal(verifications(), 2);
  } finally {
    await handler.dispose();
  }
});

test("the sender refuses an address that is not globally routable unless the deployment allows private networks", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed, { sender: NodeWebhook.sender({ ca: receiver.cert }) });
  try {
    for (const url of [receiver.url("/private"), `https://127.0.0.1:${receiver.port}/private`]) {
      const refused = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/private"), delivery: { mode: "webhook", url, secret: SECRET } }, as("alice"))));
      assert.equal(refused.error?.code, -32027, url);
      assert.deepEqual(refused.error?.data, { reason: "connection_refused" });
    }
    assert.equal(at("/private").length, 0);
    const untrusted = webhookHandler(feed, { sender: NodeWebhook.sender({ allowPrivateNetworks: true }) });
    const tls = await json(await untrusted(mcpRequest("events/subscribe", subscription("/untrusted"), as("alice"))));
    assert.deepEqual(tls.error?.data, { reason: "tls_error" });
    await untrusted.dispose();
  } finally {
    await handler.dispose();
  }
});
