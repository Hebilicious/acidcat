import assert from "node:assert/strict";
import { randomBytes } from "node:crypto";
import { after, before, test } from "node:test";

import { isJsonObject, webhookSignature, webhookSubscriptionId } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import { mcpHandler } from "../src/index.ts";
import { webhookDelivery } from "../src/node.ts";
import type { WebhookOptions } from "../src/node.ts";
import { sensorOptions, Sensors, sensorsApp } from "./sensors.ts";
import { startReceiver, testCertificate } from "./webhook-receiver.ts";
import type { Received } from "./webhook-receiver.ts";

/** Wait until a condition is true, or fail after two seconds. */
async function until(condition: () => boolean | Promise<boolean>): Promise<void> {
  const end = Date.now() + 2000;
  while (!(await condition())) {
    if (Date.now() > end) throw new Error("The condition did not become true.");
    await new Promise((resolve) => setTimeout(resolve, 2));
  }
}

const VERSION = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": VERSION };

const certificate = testCertificate();
let receiver: Awaited<ReturnType<typeof startReceiver>>;
before(async () => {
  receiver = await startReceiver(certificate);
});
/** The handlers of the tests. A test that fails before its end leaves its handler open, so the end of the file closes each one. */
const handlers: { readonly close: () => Promise<void> }[] = [];
after(async () => {
  await Promise.all(handlers.map((handler) => handler.close()));
  await receiver.close();
});

/** A new Standard Webhooks secret. */
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

/** One header of a request, as text. */
function header(request: Received | undefined, name: string): string {
  const value = request?.headers[name];
  if (typeof value !== "string") throw new Error(`The request has no header ${name}.`);
  return value;
}

/** Check the signature of a request against the secrets, in order. */
async function assertSigned(request: Received | undefined, secrets: readonly string[]): Promise<void> {
  const id = header(request, "webhook-id");
  const timestamp = Number(header(request, "webhook-timestamp"));
  assert.equal(header(request, "webhook-signature"), await webhookSignature(secrets, id, timestamp, request?.text ?? ""));
  assert.equal(header(request, "content-type"), "application/json");
}

function server(options: WebhookOptions = {}) {
  const sensors = new Sensors();
  receiver.received.length = 0;
  receiver.answer(() => undefined);
  const webhooks = webhookDelivery({ allowPrivateNetworks: true, ca: certificate.cert, retryDelayMs: () => 5, ...options });
  const handler = mcpHandler(sensorsApp, {
    name: "sensors",
    version: "0.0.0",
    allowedOrigins: [],
    ...sensorOptions(sensors),
    principal: (request) => request.headers.get("X-Principal") ?? undefined,
    webhooks,
  });
  handlers.push(handler);
  /** A request of the principal `alice`, of another principal, or with no principal (`null`). */
  const rpc = async (method: string, params: object, principal: string | null = "alice") => {
    const headers: Record<string, string> = { "Content-Type": "application/json", "MCP-Protocol-Version": VERSION };
    if (principal !== null) headers["X-Principal"] = principal;
    const response = await handler(new Request("https://sensors.example/mcp", { method: "POST", headers, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params: { ...params, _meta: META } }) }));
    return objectOf(await response.text());
  };
  const subscribe = (params: { readonly name?: string; readonly arguments?: object; readonly url?: string; readonly secret?: string; readonly [key: string]: unknown }, principal = "alice") => {
    const { url = receiver.url, secret, ...rest } = params;
    return rpc("events/subscribe", { name: "sensor.reading.changed", ...rest, delivery: { mode: "webhook", url, secret: secret ?? newSecret() } }, principal);
  };
  return { handler, rpc, subscribe, sensors };
}

test("webhook: events/list gives webhook delivery when it is on", async () => {
  const { handler, rpc } = server();
  const events = member(await rpc("events/list", {}), "result")["events"];
  assert.ok(Array.isArray(events));
  for (const event of events) assert.deepEqual(isJsonObject(event) ? event["delivery"] : undefined, ["push", "poll", "webhook"]);
  await handler.close();
});

test("webhook: a request with no principal gets Forbidden, and parameters that are not valid get -32602", async () => {
  const { handler, rpc, subscribe } = server();
  assert.deepEqual((await rpc("events/subscribe", { name: "sensor.ticks" }, null))["error"], { code: -32024, message: "Forbidden" });
  assert.deepEqual((await rpc("events/unsubscribe", { name: "sensor.ticks" }, null))["error"], { code: -32024, message: "Forbidden" });
  assert.equal(member(await subscribe({ url: `http://127.0.0.1:${receiver.port}/hook` }), "error")["code"], -32602);
  assert.equal(member(await subscribe({ url: "not a URL" }), "error")["code"], -32602);
  for (const secret of ["secret", "whsec_c2hvcnQ=", `whsec_${randomBytes(65).toString("base64")}`, "whsec_!!!!"]) {
    assert.equal(member(await subscribe({ secret }), "error")["code"], -32602, secret);
  }
  assert.equal(member(await rpc("events/subscribe", { name: "sensor.ticks", delivery: { mode: "poll" } }), "error")["code"], -32602);
  assert.equal(member(await subscribe({ ttlMs: "soon" }), "error")["code"], -32602);
  assert.deepEqual(member(await subscribe({ name: "sensor.hidden" }), "error"), { code: -32023, message: "There is no event sensor.hidden.", data: { kind: "event" } });
  // No request reached the receiver.
  assert.deepEqual(receiver.received, []);
  await handler.close();
});

test("webhook: the server verifies the endpoint, then sends signed deliveries in order", async () => {
  const { handler, subscribe, sensors } = server();
  const secret = newSecret();
  const answer = await subscribe({ arguments: { room: "hall" }, secret });
  const result = member(answer, "result");
  const id = await webhookSubscriptionId("alice", receiver.url, "sensor.reading.changed", { room: "hall" });
  assert.equal(result["id"], id);
  assert.equal(result["resultType"], "complete");
  assert.equal(result["cursor"], null);
  assert.equal(result["truncated"], false);
  assert.deepEqual(result["deliveryStatus"], { active: true, lastDeliveryAt: null, lastError: null });
  const refreshBefore = Date.parse(String(result["refreshBefore"]));
  assert.ok(Math.abs(refreshBefore - (Date.now() + 3_600_000)) < 10_000);

  const [verification] = receiver.received;
  assert.equal(verification?.body["type"], "verification");
  assert.equal(typeof verification?.body["challenge"], "string");
  assert.match(header(verification, "webhook-id"), /^msg_verification_[A-Za-z0-9]+$/);
  assert.equal(header(verification, "x-mcp-subscription-id"), id);
  await assertSigned(verification, [secret]);

  await until(() => sensors.listeners === 1);
  sensors.emit("hall", 20, "2026-11-10T09:00:00.000Z");
  sensors.emit("kitchen", 30);
  sensors.emit("hall", 21, "2026-11-10T09:00:02.000Z");
  await until(() => receiver.deliveries().length === 2);
  const [first, second] = receiver.deliveries();
  assert.deepEqual(first?.body, { eventId: "reading-0", name: "sensor.reading.changed", timestamp: "2026-11-10T09:00:00.000Z", data: { room: "hall", celsius: 20 }, cursor: "0" });
  assert.equal(second?.body["cursor"], "2");
  assert.match(header(first, "webhook-id"), /^msg_[A-Za-z0-9]+$/);
  assert.notEqual(header(first, "webhook-id"), header(second, "webhook-id"));
  assert.equal(header(first, "x-mcp-subscription-id"), id);
  await assertSigned(first, [secret]);
  await assertSigned(second, [secret]);

  // The verification covers this principal and URL: a second subscription to the same URL sends no verification.
  const before = receiver.received.length;
  assert.ok(isJsonObject((await subscribe({ name: "sensor.clock" }))["result"]));
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(receiver.received.slice(before).filter((each) => each.body["type"] === "verification").length, 0);
  await handler.close();
  assert.equal(sensors.listeners, 0);
});

test("webhook: an endpoint that does not agree gives CallbackEndpointError, and no subscription", async () => {
  const { handler, subscribe, sensors } = server();
  receiver.answer((request) => (request.body["type"] === "verification" ? { status: 200, body: JSON.stringify({ challenge: "wrong" }) } : undefined));
  assert.deepEqual(member(await subscribe({}), "error"), { code: -32027, message: "The callback endpoint did not agree to get deliveries.", data: { reason: "challenge_failed" } });
  receiver.answer(() => ({ status: 500 }));
  assert.deepEqual(member(member(await subscribe({}), "error"), "data"), { reason: "http_5xx" });
  receiver.answer(() => ({ status: 404 }));
  assert.deepEqual(member(member(await subscribe({}), "error"), "data"), { reason: "http_4xx" });
  assert.equal(sensors.listeners, 0);
  await handler.close();
});

test("webhook: a certificate that the server does not trust is tls_error", async () => {
  const { handler, subscribe } = server({ ca: undefined });
  assert.deepEqual(member(member(await subscribe({}), "error"), "data"), { reason: "tls_error" });
  await handler.close();
});

test("webhook: the server connects to no address that is not globally routable, unless the deployment allows it", async () => {
  const { handler, subscribe } = server({ allowPrivateNetworks: false });
  assert.deepEqual(member(member(await subscribe({}), "error"), "data"), { reason: "connection_refused" });
  // The host name resolves to a loopback address: the lookup refuses it.
  assert.deepEqual(member(member(await subscribe({ url: `https://localhost:${receiver.port}/hook` }), "error"), "data"), { reason: "connection_refused" });
  assert.deepEqual(receiver.received, []);
  await handler.close();
});

test("webhook: a URL of the allowlist gets deliveries with no verification", async () => {
  const { handler, subscribe, sensors } = server({ allow: (url) => url.hostname === "127.0.0.1" });
  assert.ok(isJsonObject((await subscribe({}))["result"]));
  await until(() => sensors.listeners === 1);
  sensors.emit("hall", 20);
  await until(() => receiver.received.length === 1);
  assert.equal(receiver.received[0]?.body["eventId"], "reading-0");
  await handler.close();
});

test("webhook: a status that is not 2xx makes the server send the delivery again, with the same webhook-id", async () => {
  const { handler, subscribe, sensors } = server();
  let failures = 2;
  receiver.answer((request) => (request.body["type"] === undefined && failures-- > 0 ? { status: 500 } : undefined));
  const params = { secret: newSecret() };
  assert.ok(isJsonObject((await subscribe(params))["result"]));
  await until(() => sensors.listeners === 1);
  sensors.emit("hall", 20);
  await until(() => receiver.deliveries().length === 3);
  const ids = new Set(receiver.deliveries().map((each) => header(each, "webhook-id")));
  assert.equal(ids.size, 1);
  // The server reads the last answer a little after the receiver sends it.
  let status: JsonObject = {};
  await until(async () => {
    status = member(member(await subscribe(params), "result"), "deliveryStatus");
    return status["lastDeliveryAt"] !== null;
  });
  assert.equal(status["lastError"], null);
  assert.equal(typeof status["lastDeliveryAt"], "string");
  await handler.close();
});

test("webhook: the server abandons a delivery after the last attempt, or at once after 410", async () => {
  const { handler, subscribe, sensors } = server({ attempts: 3 });
  receiver.answer((request) => {
    if (request.body["type"] !== undefined) return undefined;
    return request.body["eventId"] === "reading-0" ? { status: 410 } : request.body["eventId"] === "reading-1" ? { status: 503 } : undefined;
  });
  const params = { secret: newSecret() };
  assert.ok(isJsonObject((await subscribe(params))["result"]));
  await until(() => sensors.listeners === 1);
  sensors.emit("hall", 20);
  sensors.emit("hall", 21);
  await until(() => receiver.deliveries().length === 4);
  assert.deepEqual(
    receiver.deliveries().map((each) => each.body["eventId"]),
    ["reading-0", "reading-1", "reading-1", "reading-1"],
  );
  // The watermark passes abandoned deliveries.
  let result: JsonObject = {};
  await until(async () => {
    result = member(await subscribe(params), "result");
    return result["cursor"] === "1";
  });
  assert.equal(member(result, "deliveryStatus")["lastError"], "http_5xx");
  sensors.emit("hall", 22);
  await until(() => receiver.deliveries().length === 5);
  assert.equal(receiver.deliveries()[4]?.body["cursor"], "2");
  await handler.close();
});

test("webhook: a truncated occurrence comes after a gap message", async () => {
  const { handler, subscribe, sensors } = server();
  const old = new Date(Date.now() - 60_000).toISOString();
  sensors.emit("hall", 1, old);
  sensors.emit("hall", 2, old);
  sensors.emit("hall", 3);
  assert.ok(isJsonObject((await subscribe({ cursor: "0", maxAgeMs: 1000 }))["result"]));
  await until(() => receiver.deliveries().length === 2);
  const [gap, occurrence] = receiver.deliveries();
  assert.deepEqual(gap?.body, { type: "gap", cursor: null });
  assert.match(header(gap, "webhook-id"), /^msg_gap_[A-Za-z0-9]+$/);
  assert.equal(occurrence?.body["cursor"], "2");
  assert.equal(occurrence?.body["truncated"], undefined);
  await handler.close();
});

test("webhook: a refresh grants a new lifetime and replaces the secret, and the server signs with both secrets for a time", async () => {
  const { handler, subscribe, sensors } = server({ maxTtlMs: 7_200_000 });
  const oldSecret = newSecret();
  const newer = newSecret();
  const first = member(await subscribe({ secret: oldSecret, ttlMs: 60_000 }), "result");
  const second = member(await subscribe({ secret: newer, ttlMs: 7_200_000, cursor: "ignored" }), "result");
  assert.equal(second["id"], first["id"]);
  assert.ok(Date.parse(String(second["refreshBefore"])) > Date.parse(String(first["refreshBefore"])));
  assert.equal(receiver.received.filter((each) => each.body["type"] === "verification").length, 1);
  await until(() => sensors.listeners === 1);
  sensors.emit("hall", 20);
  await until(() => receiver.deliveries().length === 1);
  await assertSigned(receiver.deliveries()[0], [newer, oldSecret]);
  await handler.close();
});

test("webhook: after the grace time, the server signs only with the new secret", async () => {
  const { handler, subscribe, sensors } = server({ rotationGraceMs: 0 });
  const newer = newSecret();
  await subscribe({ secret: newSecret() });
  await subscribe({ secret: newer });
  await until(() => sensors.listeners === 1);
  sensors.emit("hall", 20);
  await until(() => receiver.deliveries().length === 1);
  await assertSigned(receiver.deliveries()[0], [newer]);
  await handler.close();
});

test("webhook: events/unsubscribe cancels the subscription, and a second time gives NotFound", async () => {
  const { handler, rpc, subscribe, sensors } = server();
  await subscribe({ arguments: { room: "hall" } });
  await until(() => sensors.listeners === 1);
  const params = { name: "sensor.reading.changed", arguments: { room: "hall" }, delivery: { url: receiver.url } };
  assert.deepEqual(await rpc("events/unsubscribe", params, "bob").then((answer) => answer["error"]), { code: -32023, message: "There is no such subscription.", data: { kind: "subscription" } });
  const done = await rpc("events/unsubscribe", params);
  assert.equal(member(done, "result")["resultType"], "complete");
  await until(() => sensors.listeners === 0);
  assert.equal(member(member(await rpc("events/unsubscribe", params), "error"), "data")["kind"], "subscription");
  await handler.close();
});

test("webhook: a subscription with no renewal ends at the end of its lifetime, with no message", async () => {
  const { handler, subscribe, sensors } = server({ minTtlMs: 30 });
  const result = member(await subscribe({ ttlMs: 30 }), "result");
  assert.ok(Date.parse(String(result["refreshBefore"])) - Date.now() < 1000);
  await until(() => sensors.listeners === 1);
  await until(() => sensors.listeners === 0);
  assert.deepEqual(receiver.deliveries(), []);
  await handler.close();
});

test("webhook: internal sends a terminated message, and a complete subscription ends with no message", async () => {
  const { handler, subscribe } = server();
  await subscribe({ name: "sensor.failing" });
  await until(() => receiver.deliveries().length === 2);
  const [occurrence, terminated] = receiver.deliveries();
  assert.deepEqual(occurrence?.body["data"], { room: "hall", celsius: 20 });
  assert.deepEqual(terminated?.body, { type: "terminated", error: { code: -32603, message: "The event failed." } });
  assert.match(header(terminated, "webhook-id"), /^msg_terminated_[A-Za-z0-9]+$/);

  await subscribe({ name: "sensor.ticks" });
  await until(() => receiver.deliveries().length === 5);
  await new Promise((resolve) => setTimeout(resolve, 30));
  assert.equal(receiver.deliveries().length, 5);
  await handler.close();
});

test("webhook: a new subscription over the limit of the principal gets ResourceExhausted", async () => {
  const { handler, subscribe } = server({ maxSubscriptions: 1 });
  assert.ok(isJsonObject((await subscribe({}))["result"]));
  assert.deepEqual(member(await subscribe({ arguments: { room: "hall" } }), "error"), { code: -32025, message: "Too many webhook subscriptions.", data: { limit: "subscriptions", max: 1 } });
  // A refresh is not a new subscription, and another principal has its own limit.
  assert.ok(isJsonObject((await subscribe({}))["result"]));
  assert.ok(isJsonObject((await subscribe({}, "bob"))["result"]));
  await handler.close();
});
