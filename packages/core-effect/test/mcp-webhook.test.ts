import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { isJsonObject, webhookSignature, webhookSubscriptionId } from "@acid-cat/spec-ts";
import { Effect, Option, Schedule, Schema } from "effect";

import { Mcp } from "../src/index.ts";
import * as NodeWebhook from "../src/NodeWebhook.ts";
import { events, feedForPromises } from "./events-fixture.ts";
import { delay, eventually, json, mcpRequest, ORIGIN } from "./mcp-client.ts";
import { agree, startReceiver } from "./webhook-receiver.ts";
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

/** A handler with webhook delivery to the local endpoint. The principal is the `X-User` header of each request. */
function webhookHandler(feed: ReturnType<typeof feedForPromises>, webhooks: Partial<Mcp.WebhookOptions> = {}, eventBuffer?: number) {
  return Mcp.toWebHandler(events, feed.layer, {
    name: "feed",
    version: "0.0.0",
    allowedOrigins: [ORIGIN],
    ...(eventBuffer === undefined ? {} : { eventBuffer }),
    principal: (request) => Effect.succeed(Option.fromNullOr(request.headers.get("X-User"))),
    webhooks: {
      sender: NodeWebhook.sender({ allowPrivateNetworks: true, ca: receiver.cert }),
      retryDelays: Schedule.spaced("20 millis"),
      ...webhooks,
    },
  });
}

const as = (user: string) => ({ headers: { "X-User": user } });

/** The params of `events/subscribe` for a path of the endpoint. */
const subscription = (path: string, extra: Record<string, unknown> = {}) => ({
  name: "feed.ticked",
  arguments: { room: path },
  delivery: { mode: "webhook", url: receiver.url(path), secret: SECRET },
  ...extra,
});

/** The requests of the endpoint to a path. */
const at = (path: string) => receiver.received.filter((each) => each.path === path);

/** Wait until the endpoint got `count` requests to a path, and give them. */
const waitAt = (path: string, count: number) => eventually(async () => at(path), (list) => list.length >= count, `${count} requests to ${path}`);

/** Check the signature of a request with the secrets, as a receiver does. */
async function assertSigned(received: Received, secrets: readonly string[], subscriptionId: string) {
  const id = received.headers["webhook-id"] ?? "";
  const timestamp = Number(received.headers["webhook-timestamp"]);
  assert.equal(received.headers["content-type"], "application/json");
  assert.equal(received.headers["x-mcp-subscription-id"], subscriptionId);
  assert.ok(Math.abs(timestamp - Date.now() / 1000) < 60);
  assert.equal(received.headers["webhook-signature"], await webhookSignature(secrets, id, timestamp, received.body));
}

const bodyOf = (received: Received | undefined) => (received !== undefined && isJsonObject(received.json) ? received.json : {});

test("events/subscribe and events/unsubscribe need a principal, an https URL and a valid secret", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed);
  try {
    const list = await json(await handler(mcpRequest("events/list")));
    const entries = Schema.decodeUnknownSync(Schema.Struct({ events: Schema.Array(Schema.Struct({ delivery: Schema.Array(Schema.String) })) }))(list.result);
    assert.deepEqual(entries.events[0]?.delivery, ["push", "poll", "webhook"]);
    const anonymous = await json(await handler(mcpRequest("events/subscribe", subscription("/anonymous"))));
    assert.equal(anonymous.error?.code, -32024);
    const anonymousOut = await json(await handler(mcpRequest("events/unsubscribe", subscription("/anonymous"))));
    assert.equal(anonymousOut.error?.code, -32024);
    const plain = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/plain"), delivery: { mode: "webhook", url: "http://localhost/plain", secret: SECRET } }, as("alice"))));
    assert.equal(plain.error?.code, -32602);
    for (const secret of ["secret", "whsec_c2hvcnQ=", `whsec_${Buffer.from("x".repeat(65)).toString("base64")}`]) {
      const bad = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/bad"), delivery: { mode: "webhook", url: receiver.url("/bad"), secret } }, as("alice"))));
      assert.equal(bad.error?.code, -32602, secret);
    }
    const hidden = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/hidden"), name: "feed.hidden" }, as("alice"))));
    assert.equal(hidden.error?.code, -32023);
    assert.equal(at("/plain").length + at("/bad").length + at("/anonymous").length + at("/hidden").length, 0);
  } finally {
    await handler.dispose();
  }
});

test("events/subscribe checks the name before maxAgeMs, and a renewal checks maxAgeMs too", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed, { allow: () => true });
  try {
    for (const maxAgeMs of [-1, 1.5, "60"]) {
      const unknown = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/order"), name: "no.such", maxAgeMs }, as("alice"))));
      assert.equal(unknown.error?.code, -32023, `maxAgeMs ${maxAgeMs}`);
      assert.deepEqual(unknown.error?.data, { kind: "event" });
      const invalid = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/order"), maxAgeMs }, as("alice"))));
      assert.equal(invalid.error?.code, -32602, `maxAgeMs ${maxAgeMs}`);
    }
    const started = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/order"), maxAgeMs: null }, as("alice"))));
    assert.equal(started.error, undefined);
    const renewed = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/order"), maxAgeMs: -1 }, as("alice"))));
    assert.equal(renewed.error?.code, -32602);
  } finally {
    await handler.dispose();
  }
});

test("a new subscription verifies the URL, then sends each occurrence signed, with the watermark as its cursor", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed);
  try {
    const answer = await json(await handler(mcpRequest("events/subscribe", subscription("/hooks"), as("alice"))));
    const result = decodeSubscribeResult(answer.result);
    const id = await webhookSubscriptionId("alice", receiver.url("/hooks"), "feed.ticked", { room: "/hooks" });
    assert.equal(result.id, id);
    assert.deepEqual({ ...result, refreshBefore: "" }, { resultType: "complete", id, refreshBefore: "", cursor: null, truncated: false, deliveryStatus: { active: true, lastDeliveryAt: null, lastError: null } });
    const lifetime = Date.parse(result.refreshBefore) - Date.now();
    assert.ok(lifetime > 3_590_000 && lifetime <= 3_600_000, `${lifetime}`);

    const [verification] = await waitAt("/hooks", 1);
    assert.ok(verification);
    assert.equal(bodyOf(verification).type, "verification");
    assert.match(verification.headers["webhook-id"] ?? "", /^msg_verification_[A-Za-z0-9]+$/);
    await assertSigned(verification, [SECRET], id);

    await feed.following(1);
    await feed.publish({ room: "/hooks", count: 1 });
    const delivered = (await waitAt("/hooks", 2))[1];
    assert.ok(delivered);
    assert.match(delivered.headers["webhook-id"] ?? "", /^msg_[A-Za-z0-9]+$/);
    await assertSigned(delivered, [SECRET], id);
    const body = bodyOf(delivered);
    assert.deepEqual({ ...body, eventId: "", timestamp: "" }, { eventId: "", name: "feed.ticked", timestamp: "", data: { room: "/hooks", count: 1 }, cursor: "1" });

    // The same principal and URL with other arguments needs no new verification.
    await json(await handler(mcpRequest("events/subscribe", { ...subscription("/hooks"), arguments: { room: "other" } }, as("alice"))));
    await feed.following(2);
    assert.equal(at("/hooks").length, 2);
    // Another principal verifies the URL again.
    await json(await handler(mcpRequest("events/subscribe", subscription("/hooks"), as("bob"))));
    assert.equal(at("/hooks").length, 3);
    assert.equal(bodyOf(at("/hooks")[2]).type, "verification");
  } finally {
    await handler.dispose();
  }
  await feed.following(0);
});

test("an endpoint that does not answer the challenge fails the subscription with CallbackEndpointError", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed);
  try {
    receiver.respond((received) => (received.path === "/wrong" ? { status: 200, body: JSON.stringify({ challenge: "wrong" }) } : received.path === "/gone" ? { status: 404 } : { status: 503 }));
    const wrong = await json(await handler(mcpRequest("events/subscribe", subscription("/wrong"), as("alice"))));
    assert.equal(wrong.error?.code, -32027);
    assert.deepEqual(wrong.error?.data, { reason: "challenge_failed" });
    const gone = await json(await handler(mcpRequest("events/subscribe", subscription("/gone"), as("alice"))));
    assert.deepEqual(gone.error?.data, { reason: "http_4xx" });
    const down = await json(await handler(mcpRequest("events/subscribe", subscription("/down"), as("alice"))));
    assert.deepEqual(down.error?.data, { reason: "http_5xx" });
    await feed.following(0);
    assert.equal(at("/wrong").length, 1);
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

test("a delivery is sent again after a status that is not 2xx, with the same webhook-id; 410 abandons it", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed);
  try {
    const statuses = [500, 200, 410, 200];
    receiver.respond((received) => (received.path === "/retry" && bodyOf(received).type === undefined ? { status: statuses.shift() ?? 200 } : agree(received)));
    const id = decodeSubscribeResult((await json(await handler(mcpRequest("events/subscribe", subscription("/retry"), as("alice"))))).result).id;
    await feed.following(1);
    await feed.publish({ room: "/retry", count: 1 });
    const [, failed, retried] = await waitAt("/retry", 3);
    assert.ok(failed && retried);
    assert.equal(retried.headers["webhook-id"], failed.headers["webhook-id"]);
    assert.equal(retried.body, failed.body);
    await assertSigned(retried, [SECRET], id);

    await feed.publish({ room: "/retry", count: 2 });
    const abandoned = (await waitAt("/retry", 4))[3];
    assert.equal(bodyOf(abandoned).cursor, "2");
    await delay(100);
    assert.equal(at("/retry").length, 4);
    const status = decodeSubscribeResult((await json(await handler(mcpRequest("events/subscribe", subscription("/retry"), as("alice"))))).result);
    assert.equal(status.deliveryStatus.lastError, "http_4xx");
    // The watermark covers the abandoned delivery.
    assert.equal(status.cursor, "2");

    await feed.publish({ room: "/retry", count: 3 });
    await waitAt("/retry", 5);
    const healthy = await eventually(
      async () => decodeSubscribeResult((await json(await handler(mcpRequest("events/subscribe", subscription("/retry"), as("alice"))))).result),
      (result) => result.deliveryStatus.lastError === null,
      "a successful delivery",
    );
    assert.equal(healthy.cursor, "3");
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
    receiver.respond((received) => (received.path === "/failing" && bodyOf(received).type === undefined ? { status: 500 } : agree(received)));
    await json(await handler(mcpRequest("events/subscribe", subscription("/failing"), as("alice"))));
    await feed.following(1);
    await feed.publish({ room: "/failing", count: 1 });
    await waitAt("/failing", 4);
    await delay(150);
    assert.equal(at("/failing").length, 4);
    const status = decodeSubscribeResult((await json(await handler(mcpRequest("events/subscribe", subscription("/failing"), as("alice"))))).result);
    assert.equal(status.deliveryStatus.lastError, "http_5xx");
  } finally {
    receiver.respond(agree);
    await handler.dispose();
  }
});

test("a gap message comes before an occurrence with truncated: true", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed, {}, 1);
  let release = () => {};
  const held = new Promise<void>((resolve) => (release = resolve));
  try {
    receiver.respond(async (received) => {
      if (received.path === "/gap" && bodyOf(received).cursor === "1") await held;
      return agree(received);
    });
    await json(await handler(mcpRequest("events/subscribe", subscription("/gap"), as("alice"))));
    await feed.following(1);
    await feed.publish({ room: "/gap", count: 1 });
    await waitAt("/gap", 2);
    for (const count of [2, 3, 4]) await feed.publish({ room: "/gap", count });
    await delay(50);
    release();
    const [, , gap, next] = await waitAt("/gap", 4);
    assert.deepEqual(bodyOf(gap), { type: "gap", cursor: "1" });
    assert.match(gap?.headers["webhook-id"] ?? "", /^msg_gap_[A-Za-z0-9]+$/);
    assert.equal(bodyOf(next).cursor, "4");
    assert.equal("truncated" in bodyOf(next), false);
  } finally {
    release();
    receiver.respond(agree);
    await handler.dispose();
  }
});

test("a refresh grants a new lifetime and replaces the secret, and both secrets sign during the grace time", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed, { minTtlMs: 1000, rotationGraceMs: 300 });
  try {
    const first = decodeSubscribeResult((await json(await handler(mcpRequest("events/subscribe", subscription("/rotate", { ttlMs: 5 }), as("alice"))))).result);
    const lifetime = Date.parse(first.refreshBefore) - Date.now();
    assert.ok(lifetime > 900 && lifetime <= 1000, `${lifetime}`);
    await feed.following(1);
    const renewed = decodeSubscribeResult(
      (await json(await handler(mcpRequest("events/subscribe", { ...subscription("/rotate", { ttlMs: 120_000 }), delivery: { mode: "webhook", url: receiver.url("/rotate"), secret: NEW_SECRET } }, as("alice"))))).result,
    );
    assert.equal(renewed.id, first.id);
    assert.ok(Date.parse(renewed.refreshBefore) - Date.now() > 100_000);
    assert.equal(at("/rotate").length, 1);
    await feed.following(1);

    await feed.publish({ room: "/rotate", count: 1 });
    const [, dual] = await waitAt("/rotate", 2);
    assert.ok(dual);
    assert.equal(dual.headers["webhook-signature"]?.split(" ").length, 2);
    await assertSigned(dual, [NEW_SECRET, SECRET], first.id);

    await delay(350);
    await feed.publish({ room: "/rotate", count: 2 });
    const [, , single] = await waitAt("/rotate", 3);
    assert.ok(single);
    await assertSigned(single, [NEW_SECRET], first.id);
  } finally {
    await handler.dispose();
  }
});

test("events/unsubscribe cancels the subscription, and a subscription ends when its lifetime ends", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed, { minTtlMs: 100 });
  try {
    await json(await handler(mcpRequest("events/subscribe", subscription("/end"), as("alice"))));
    await feed.following(1);
    const missing = await json(await handler(mcpRequest("events/unsubscribe", { name: "feed.ticked", arguments: { room: "/end" }, delivery: { url: receiver.url("/end") } }, as("bob"))));
    assert.equal(missing.error?.code, -32023);
    assert.deepEqual(missing.error?.data, { kind: "subscription" });
    const done = await json(await handler(mcpRequest("events/unsubscribe", { name: "feed.ticked", arguments: { room: "/end" }, delivery: { url: receiver.url("/end") } }, as("alice"))));
    assert.deepEqual(done.result, { resultType: "complete" });
    await feed.following(0);
    const again = await json(await handler(mcpRequest("events/unsubscribe", { name: "feed.ticked", arguments: { room: "/end" }, delivery: { url: receiver.url("/end") } }, as("alice"))));
    assert.equal(again.error?.code, -32023);

    await json(await handler(mcpRequest("events/subscribe", subscription("/end", { ttlMs: 100 }), as("alice"))));
    await feed.following(1);
    await feed.following(0);
    assert.equal(at("/end").length, 1);
  } finally {
    await handler.dispose();
  }
});

test("internal ends the subscription with a terminated message", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed);
  try {
    const id = decodeSubscribeResult((await json(await handler(mcpRequest("events/subscribe", { ...subscription("/crash"), name: "feed.crashing", arguments: {} }, as("alice"))))).result).id;
    const [, occurrence, terminated] = await waitAt("/crash", 3);
    assert.equal(bodyOf(occurrence).name, "feed.crashing");
    assert.deepEqual(bodyOf(terminated), { type: "terminated", error: { code: -32603, message: "The event failed." } });
    assert.match(terminated?.headers["webhook-id"] ?? "", /^msg_terminated_[A-Za-z0-9]+$/);
    if (terminated !== undefined) await assertSigned(terminated, [SECRET], id);
    // The subscription no longer exists.
    const missing = await eventually(
      async () => json(await handler(mcpRequest("events/unsubscribe", { name: "feed.crashing", arguments: {}, delivery: { url: receiver.url("/crash") } }, as("alice")))),
      (answer) => answer.error !== undefined,
      "the end of the subscription",
    );
    assert.equal(missing.error?.code, -32023);
  } finally {
    await handler.dispose();
  }
});

test("parallel new subscriptions of one principal cannot pass the limit together", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed, { maxSubscriptions: 2 });
  try {
    // Each URL is new, so each subscription waits for its verification before it exists.
    const answers = await Promise.all(
      ["a", "b", "c", "d"].map(async (room) => json(await handler(mcpRequest("events/subscribe", subscription(`/parallel-${room}`), as("erin"))))),
    );
    assert.equal(answers.filter((answer) => answer.error === undefined).length, 2);
    assert.equal(answers.filter((answer) => answer.error?.code === -32025).length, 2);
  } finally {
    await handler.dispose();
  }
});

test("a principal gets ResourceExhausted over the maximum number of subscriptions", async () => {
  const feed = feedForPromises();
  const handler = webhookHandler(feed, { maxSubscriptions: 2 });
  try {
    for (const room of ["one", "two"]) decodeSubscribeResult((await json(await handler(mcpRequest("events/subscribe", { ...subscription("/limit"), arguments: { room } }, as("carol"))))).result);
    const over = await json(await handler(mcpRequest("events/subscribe", { ...subscription("/limit"), arguments: { room: "three" } }, as("carol"))));
    assert.equal(over.error?.code, -32025);
    assert.deepEqual(over.error?.data, { limit: "subscriptions", max: 2 });
    // A refresh of a subscription that exists is not a new subscription.
    decodeSubscribeResult((await json(await handler(mcpRequest("events/subscribe", { ...subscription("/limit"), arguments: { room: "one" } }, as("carol"))))).result);
    decodeSubscribeResult((await json(await handler(mcpRequest("events/subscribe", { ...subscription("/limit"), arguments: { room: "three" } }, as("dave"))))).result);
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
    // Without the certificate authority of the test, TLS fails.
    const untrusted = webhookHandler(feed, { sender: NodeWebhook.sender({ allowPrivateNetworks: true }) });
    const tls = await json(await untrusted(mcpRequest("events/subscribe", subscription("/untrusted"), as("alice"))));
    assert.deepEqual(tls.error?.data, { reason: "tls_error" });
    await untrusted.dispose();
  } finally {
    await handler.dispose();
  }
});
