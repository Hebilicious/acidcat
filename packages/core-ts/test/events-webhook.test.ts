import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";
import type { TestContext } from "node:test";

import { isJsonObject, webhookSignature, webhookSubscriptionId } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import { mcpHandler } from "../src/index.ts";
import { webhookDelivery } from "../src/node.ts";
import type { WebhookOptions } from "../src/node.ts";
import { sensorOptions, Sensors, sensorsApp } from "./sensors.ts";
import { startReceiver, testCertificate, testSigningKey } from "./webhook-receiver.ts";
import type { Received } from "./webhook-receiver.ts";
import { until } from "../../../test-support/until.ts";
import { mcpHeaders } from "./mcp-headers.ts";
import { ManualClock } from "./manual-clock.ts";

const VERSION = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": VERSION };

const certificate = testCertificate();
let receiver: Awaited<ReturnType<typeof startReceiver>>;
before(async () => {
  receiver = await startReceiver(certificate);
});
after(async () => {
  await receiver.close();
});

const newSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

function objectOf(text: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error("The message is not an object.");
  return value;
}

function member(value: JsonObject, key: string): JsonObject {
  const inner = value[key];
  if (!isJsonObject(inner)) throw new Error(`The member ${key} is not an object: ${JSON.stringify(value)}`);
  return inner;
}

function header(request: Received | undefined, name: string): string {
  const value = request?.headers[name];
  if (typeof value !== "string") throw new Error(`The request has no header ${name}.`);
  return value;
}

async function assertSigned(request: Received | undefined, secrets: readonly string[]): Promise<void> {
  const id = header(request, "webhook-id");
  const timestamp = Number(header(request, "webhook-timestamp"));
  assert.equal(header(request, "webhook-signature"), await webhookSignature(secrets, id, timestamp, request?.text ?? ""));
  assert.equal(header(request, "content-type"), "application/json");
}

function server(t: TestContext, options: WebhookOptions = {}, serverCard?: { readonly name: string }) {
  const sensors = new Sensors();
  receiver.received.length = 0;
  receiver.answer(() => undefined);
  const clock = new ManualClock();
  const webhooks = webhookDelivery({ allowPrivateNetworks: true, ca: certificate.cert, clock, retryDelayMs: () => 0, ...options });
  const handler = mcpHandler(sensorsApp, {
    name: "sensors",
    version: "0.0.0",
    allowedOrigins: [],
    ...sensorOptions(sensors),
    principal: (request) => request.headers.get("X-Principal") ?? undefined,
    webhooks,
    serverCard,
  });
  t.after(() => handler.close());
  const rpc = async (method: string, params: object, principal: string | null = "alice", signal?: AbortSignal) => {
    const headers: Record<string, string> = { "Content-Type": "application/json", ...mcpHeaders(method, params), "MCP-Protocol-Version": VERSION };
    if (principal !== null) headers["X-Principal"] = principal;
    const response = await handler(new Request("https://sensors.example/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }), ...(signal === undefined ? {} : { signal }) }));
    return objectOf(await response.text());
  };
  const subscribe = (params: { readonly name?: string; readonly arguments?: object; readonly url?: string; readonly secret?: string; readonly [key: string]: unknown }, principal = "alice", signal?: AbortSignal) => {
    const { url = receiver.url, secret, ...rest } = params;
    return rpc("events/subscribe", { name: "sensor.reading.changed", ...rest, delivery: { mode: "webhook", url, secret: secret ?? newSecret() } }, principal, signal);
  };
  return { handler, rpc, subscribe, sensors, clock };
}


test("webhook: parameters that are not valid get -32602, and an unknown event gets NotFound, with no request to the receiver", async (t) => {
  const { rpc, subscribe } = server(t);
  assert.equal(member(await subscribe({ url: "not a URL" }), "error")["code"], -32602);
  for (const secret of [`whsec_${randomBytes(65).toString("base64")}`, "whsec_!!!!"]) {
    assert.equal(member(await subscribe({ secret }), "error")["code"], -32602, secret);
  }
  assert.equal(member(await rpc("events/subscribe", { name: "sensor.ticks", delivery: { mode: "poll" } }), "error")["code"], -32602);
  assert.equal(member(await subscribe({ ttlMs: "soon" }), "error")["code"], -32602);
  assert.deepEqual(member(await subscribe({ name: "sensor.hidden" }), "error"), { code: -32023, message: "There is no event sensor.hidden.", data: { kind: "event" } });
  assert.deepEqual(receiver.received, []);
});

test("webhook: a new subscription has no watermark and a delivery status with no delivery and no error", async (t) => {
  const { subscribe } = server(t);
  const result = member(await subscribe({ arguments: { room: "hall" } }), "result");
  assert.equal(result["cursor"], null);
  assert.deepEqual(result["deliveryStatus"], { active: true, lastDeliveryAt: null, lastError: null });
});

test("webhook: a truncated occurrence before the first delivery comes after a gap message with no cursor", async (t) => {
  const { handler, subscribe, sensors } = server(t);
  const old = new Date(Date.now() - 60_000).toISOString();
  sensors.emit("hall", 1, old);
  sensors.emit("hall", 2, old);
  sensors.emit("hall", 3);
  assert.ok(isJsonObject((await subscribe({ cursor: "0", maxAgeMs: 1000 }))["result"]));
  await receiver.waitForDeliveries(t, 2);
  await handler.close();
  const [gap, occurrence, ...more] = receiver.deliveries();
  assert.deepEqual(gap?.body, { type: "gap", cursor: null });
  assert.equal(occurrence?.body["cursor"], "2");
  assert.deepEqual(more, []);
});

test("webhook: the reason of CallbackEndpointError tells the status of the answer to the verification, and no subscription starts", async (t) => {
  const { subscribe, sensors } = server(t);
  for (const status of [302, 399]) {
    receiver.answer(() => ({ status }));
    assert.deepEqual(member(member(await subscribe({}), "error"), "data"), { reason: "challenge_failed" }, String(status));
  }
  receiver.answer(() => ({ status: 500 }));
  assert.deepEqual(member(member(await subscribe({}), "error"), "data"), { reason: "http_5xx" });
  receiver.answer(() => ({ status: 404 }));
  assert.deepEqual(member(member(await subscribe({}), "error"), "data"), { reason: "http_4xx" });
  assert.equal(sensors.listeners, 0);
});

test("webhook: the wait for each answer runs on the clock of the deployment, and when it ends the reason is timeout", async (t) => {
  const { subscribe, sensors, clock } = server(t, { timeoutMs: 1 });
  const held = Promise.withResolvers<undefined>();
  receiver.answer(() => held.promise);
  const slow = subscribe({ arguments: { room: "slow" } });
  await receiver.waitForRequests(t, 1);
  held.resolve(undefined);
  assert.ok(isJsonObject((await slow)["result"]));
  receiver.answer(() => new Promise(() => {}));
  const late = subscribe({ arguments: { room: "late" }, url: `${receiver.url}?late` });
  await receiver.waitForRequests(t, 2);
  clock.advance(1);
  assert.deepEqual(member(member(await late, "error"), "data"), { reason: "timeout" });
  assert.equal(sensors.listeners, 1);
});

test("webhook: the subscription id and key use delivery.url as the client sent it, not the parsed URL", async (t) => {
  const { rpc, subscribe, sensors } = server(t);
  const sent = `https://127.0.0.1:${receiver.port}/other/../hook`;
  assert.notEqual(new URL(sent).href, sent);
  const result = member(await subscribe({ arguments: { room: "hall" }, url: sent }), "result");
  assert.equal(result["id"], await webhookSubscriptionId("alice", sent, "sensor.reading.changed", { room: "hall" }));
  await until(t, () => sensors.listeners, (listeners) => listeners === 1);
  const parsed = { name: "sensor.reading.changed", arguments: { room: "hall" }, delivery: { url: new URL(sent).href } };
  assert.equal(member(member(await rpc("events/unsubscribe", parsed), "error"), "data")["kind"], "subscription");
  const done = await rpc("events/unsubscribe", { ...parsed, delivery: { url: sent } });
  assert.equal(member(done, "result")["resultType"], "complete");
  await until(t, () => sensors.listeners, (listeners) => listeners === 0);
});

test("webhook: maxAgeMs that is not an integer of 0 or more is -32602, after the id of the event", async (t) => {
  const { subscribe, sensors } = server(t);
  for (const maxAgeMs of [1.5, -1, "soon"]) {
    assert.equal(member(await subscribe({ maxAgeMs }), "error")["code"], -32602, String(maxAgeMs));
    assert.equal(member(await subscribe({ name: "sensor.hidden", maxAgeMs }), "error")["code"], -32023, String(maxAgeMs));
  }
  member(await subscribe({ arguments: { room: "hall" } }), "result");
  assert.equal(member(await subscribe({ arguments: { room: "hall" }, maxAgeMs: 1.5 }), "error")["code"], -32602);
  await until(t, () => sensors.listeners, (listeners) => listeners === 1);
});

test("webhook: a certificate that the server does not trust is tls_error", async (t) => {
  const { subscribe } = server(t, { ca: undefined });
  assert.deepEqual(member(member(await subscribe({}), "error"), "data"), { reason: "tls_error" });
});

test("webhook: the server connects to no address that is not globally routable, unless the deployment allows it", async (t) => {
  const { subscribe } = server(t, { allowPrivateNetworks: false });
  assert.deepEqual(member(member(await subscribe({}), "error"), "data"), { reason: "connection_refused" });
  assert.deepEqual(member(member(await subscribe({ url: `https://localhost:${receiver.port}/hook` }), "error"), "data"), { reason: "connection_refused" });
  assert.deepEqual(receiver.received, []);
});

test("webhook: a URL of the allowlist gets deliveries with no verification", async (t) => {
  const { handler, subscribe, sensors } = server(t, { allow: (url) => url.hostname === "127.0.0.1" });
  assert.ok(isJsonObject((await subscribe({}))["result"]));
  await until(t, () => sensors.listeners, (listeners) => listeners === 1);
  sensors.emit("hall", 20);
  await receiver.waitForDeliveries(t, 1);
  await handler.close();
  assert.deepEqual(
    receiver.received.map((each) => each.body["eventId"]),
    ["reading-0"],
  );
});

test("webhook: after a delivery that succeeds on a retry, the delivery status has the time of the delivery and no error", async (t) => {
  const { handler, subscribe, sensors } = server(t);
  let failures = 2;
  receiver.answer((request) => (request.body["type"] === undefined && failures-- > 0 ? { status: 500 } : undefined));
  const params = { secret: newSecret() };
  assert.ok(isJsonObject((await subscribe(params))["result"]));
  await until(t, () => sensors.listeners, (listeners) => listeners === 1);
  sensors.emit("hall", 20);
  await receiver.waitForDeliveries(t, 3);
  const status = await until(
    t,
    async (signal) => member(member(await subscribe(params, "alice", signal), "result"), "deliveryStatus"),
    (seen) => seen["lastDeliveryAt"] !== null,
  );
  assert.equal(status["lastError"], null);
  assert.equal(typeof status["lastDeliveryAt"], "string");
  await handler.close();
  assert.deepEqual(
    receiver.deliveries().map((each) => each.body["eventId"]),
    ["reading-0", "reading-0", "reading-0"],
  );
});

test("webhook: the server abandons a delivery after the last attempt, keeps the error, and sends the next occurrence", async (t) => {
  const { handler, subscribe, sensors } = server(t, { attempts: 3 });
  receiver.answer((request) => (request.body["type"] === undefined && request.body["eventId"] === "reading-0" ? { status: 503 } : undefined));
  const params = { secret: newSecret() };
  assert.ok(isJsonObject((await subscribe(params))["result"]));
  await until(t, () => sensors.listeners, (listeners) => listeners === 1);
  sensors.emit("hall", 20);
  await receiver.waitForDeliveries(t, 3);
  const result = await until(t, async (signal) => member(await subscribe(params, "alice", signal), "result"), (seen) => seen["cursor"] === "0");
  assert.equal(member(result, "deliveryStatus")["lastError"], "http_5xx");
  sensors.emit("hall", 21);
  await receiver.waitForDeliveries(t, 4);
  await handler.close();
  assert.deepEqual(
    receiver.deliveries().map((each) => each.body["eventId"]),
    ["reading-0", "reading-0", "reading-0", "reading-1"],
  );
});

test("webhook: after the grace time, the server signs only with the new secret", async (t) => {
  const { handler, subscribe, sensors } = server(t, { rotationGraceMs: 0 });
  const newer = newSecret();
  await subscribe({ secret: newSecret() });
  await subscribe({ secret: newer });
  await until(t, () => sensors.listeners, (listeners) => listeners === 1);
  sensors.emit("hall", 20);
  await receiver.waitForDeliveries(t, 1);
  await handler.close();
  const [delivery, ...more] = receiver.deliveries();
  await assertSigned(delivery, [newer]);
  assert.deepEqual(more, []);
});

test("webhook: the Server Card gives the egress ranges and the public signing keys, by kid", async (t) => {
  const egressIpRanges = ["203.0.113.0/24", "2001:db8::/32"];
  const { handler } = server(t, { signingKeys: [testSigningKey("first"), testSigningKey("second")], egressIpRanges }, { name: "dev.acid-cat/sensors" });
  const card = objectOf(await (await handler(new Request("https://sensors.example/mcp/server-card"))).text());
  const remotes: unknown = card["remotes"];
  const remote: unknown = Array.isArray(remotes) ? remotes[0] : undefined;
  const webhooks = isJsonObject(remote) ? member(member(member(remote, "extensionsInfo"), "io.modelcontextprotocol/events"), "webhooks") : {};
  assert.deepEqual(webhooks["egressIpRanges"], egressIpRanges);
  const keys = member(webhooks, "signingKeys")["keys"];
  assert.ok(Array.isArray(keys));
  assert.deepEqual(
    keys.map((key: unknown) => (isJsonObject(key) ? [key["kid"], Object.keys(key).sort()] : undefined)),
    [["first", ["crv", "kid", "kty", "x"]], ["second", ["crv", "kid", "kty", "x"]]],
  );
});

test("webhook: a signing key of another form, two keys with the same kid, or an egress range that is not CIDR text, make webhookDelivery throw", () => {
  const key = testSigningKey("same");
  assert.throws(() => webhookDelivery({ signingKeys: [{ ...key, d: "short" }] }), TypeError);
  assert.throws(() => webhookDelivery({ signingKeys: [key, { ...testSigningKey("other"), kid: "same" }] }), TypeError);
  for (const range of ["10.0.0.0/33", "10.0.0.0", "bad/8", "2001:db8::/129"]) assert.throws(() => webhookDelivery({ egressIpRanges: [range] }), TypeError, range);
});

test("webhook: events/unsubscribe of the subscription of another principal gives NotFound", async (t) => {
  const { rpc, subscribe, sensors } = server(t);
  await subscribe({ arguments: { room: "hall" } });
  await until(t, () => sensors.listeners, (listeners) => listeners === 1);
  const params = { name: "sensor.reading.changed", arguments: { room: "hall" }, delivery: { url: receiver.url } };
  assert.deepEqual(await rpc("events/unsubscribe", params, "bob").then((answer) => answer["error"]), { code: -32023, message: "There is no such subscription.", data: { kind: "subscription" } });
  assert.equal(sensors.listeners, 1);
});

test("webhook: a complete subscription ends with no message", async (t) => {
  const { subscribe } = server(t, { maxSubscriptions: 1 });
  assert.ok(isJsonObject((await subscribe({ name: "sensor.ticks" }))["result"]));
  const firstEnded = async (signal: AbortSignal) => isJsonObject((await subscribe({}, "alice", signal))["result"]);
  await until(t, firstEnded);
  assert.equal(receiver.deliveries().length, 3);
});

test("webhook: a defect after an occurrence sends one terminated message, then the subscription ends", async (t) => {
  const { subscribe } = server(t, { maxSubscriptions: 1 });
  assert.ok(isJsonObject((await subscribe({ name: "sensor.failing" }))["result"]));
  const firstEnded = async (signal: AbortSignal) => isJsonObject((await subscribe({}, "alice", signal))["result"]);
  await until(t, firstEnded);
  assert.deepEqual(
    receiver.received.map((each) => each.body["type"] ?? each.body["name"]),
    ["verification", "sensor.failing", "terminated"],
  );
});

test("webhook: parallel new subscriptions of one principal cannot pass the limit together", async (t) => {
  const { subscribe } = server(t, { maxSubscriptions: 2 });
  const answers = await Promise.all(["a", "b", "c", "d"].map((room) => subscribe({ arguments: { room }, url: `${receiver.url}?room=${room}` })));
  assert.equal(answers.filter((answer) => isJsonObject(answer["result"])).length, 2);
  assert.equal(answers.filter((answer) => isJsonObject(answer["error"]) && answer["error"]["code"] === -32025).length, 2);
});

test("webhook: the verification is for the pair of the principal and the URL as the client sent it", async (t) => {
  const { subscribe } = server(t);
  const spelled = receiver.url.replace("https://", "HTTPS://");
  assert.ok(isJsonObject((await subscribe({ arguments: { room: "a" } }))["result"]));
  assert.ok(isJsonObject((await subscribe({ arguments: { room: "b" } }))["result"]));
  assert.ok(isJsonObject((await subscribe({ arguments: { room: "c" }, url: spelled }))["result"]));
  assert.equal(receiver.received.filter((each) => each.body["type"] === "verification").length, 2);
});

