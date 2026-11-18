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
import { until } from "./until.ts";

const VERSION = "2026-07-28";
const META = { "io.modelcontextprotocol/protocolVersion": VERSION };

const certificate = testCertificate();
let receiver: Awaited<ReturnType<typeof startReceiver>>;
before(async () => {
  receiver = await startReceiver(certificate);
});
const handlers: { readonly close: () => Promise<void> }[] = [];
after(async () => {
  await Promise.all(handlers.map((handler) => handler.close()));
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

test("webhook: parameters that are not valid get -32602, and an unknown event gets NotFound, with no request to the receiver", async () => {
  const { handler, rpc, subscribe } = server();
  assert.equal(member(await subscribe({ url: "not a URL" }), "error")["code"], -32602);
  for (const secret of [`whsec_${randomBytes(65).toString("base64")}`, "whsec_!!!!"]) {
    assert.equal(member(await subscribe({ secret }), "error")["code"], -32602, secret);
  }
  assert.equal(member(await rpc("events/subscribe", { name: "sensor.ticks", delivery: { mode: "poll" } }), "error")["code"], -32602);
  assert.equal(member(await subscribe({ ttlMs: "soon" }), "error")["code"], -32602);
  assert.deepEqual(member(await subscribe({ name: "sensor.hidden" }), "error"), { code: -32023, message: "There is no event sensor.hidden.", data: { kind: "event" } });
  assert.deepEqual(receiver.received, []);
  await handler.close();
});

test("webhook: a new subscription has no watermark and a delivery status with no delivery and no error", async () => {
  const { handler, subscribe } = server();
  const result = member(await subscribe({ arguments: { room: "hall" } }), "result");
  assert.equal(result["cursor"], null);
  assert.deepEqual(result["deliveryStatus"], { active: true, lastDeliveryAt: null, lastError: null });
  await handler.close();
});

test("webhook: the reason of CallbackEndpointError tells the status of the answer to the verification, and no subscription starts", async () => {
  const { handler, subscribe, sensors } = server();
  for (const status of [302, 399]) {
    receiver.answer(() => ({ status }));
    assert.deepEqual(member(member(await subscribe({}), "error"), "data"), { reason: "challenge_failed" }, String(status));
  }
  receiver.answer(() => ({ status: 500 }));
  assert.deepEqual(member(member(await subscribe({}), "error"), "data"), { reason: "http_5xx" });
  receiver.answer(() => ({ status: 404 }));
  assert.deepEqual(member(member(await subscribe({}), "error"), "data"), { reason: "http_4xx" });
  assert.equal(sensors.listeners, 0);
  await handler.close();
});

test("webhook: the subscription id and key use delivery.url as the client sent it, not the parsed URL", async () => {
  const { handler, rpc, subscribe, sensors } = server();
  const sent = `https://127.0.0.1:${receiver.port}/other/../hook`;
  assert.notEqual(new URL(sent).href, sent);
  const result = member(await subscribe({ arguments: { room: "hall" }, url: sent }), "result");
  assert.equal(result["id"], await webhookSubscriptionId("alice", sent, "sensor.reading.changed", { room: "hall" }));
  await until(() => sensors.listeners === 1);
  const parsed = { name: "sensor.reading.changed", arguments: { room: "hall" }, delivery: { url: new URL(sent).href } };
  assert.equal(member(member(await rpc("events/unsubscribe", parsed), "error"), "data")["kind"], "subscription");
  const done = await rpc("events/unsubscribe", { ...parsed, delivery: { url: sent } });
  assert.equal(member(done, "result")["resultType"], "complete");
  await until(() => sensors.listeners === 0);
  await handler.close();
});

test("webhook: maxAgeMs that is not an integer of 0 or more is -32602, after the id of the event", async () => {
  const { handler, subscribe, sensors } = server();
  for (const maxAgeMs of [1.5, -1, "soon"]) {
    assert.equal(member(await subscribe({ maxAgeMs }), "error")["code"], -32602, String(maxAgeMs));
    assert.equal(member(await subscribe({ name: "sensor.hidden", maxAgeMs }), "error")["code"], -32023, String(maxAgeMs));
  }
  member(await subscribe({ arguments: { room: "hall" } }), "result");
  assert.equal(member(await subscribe({ arguments: { room: "hall" }, maxAgeMs: 1.5 }), "error")["code"], -32602);
  await until(() => sensors.listeners === 1);
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

test("webhook: after a delivery that succeeds on a retry, the delivery status has the time of the delivery and no error", async () => {
  const { handler, subscribe, sensors } = server();
  let failures = 2;
  receiver.answer((request) => (request.body["type"] === undefined && failures-- > 0 ? { status: 500 } : undefined));
  const params = { secret: newSecret() };
  assert.ok(isJsonObject((await subscribe(params))["result"]));
  await until(() => sensors.listeners === 1);
  sensors.emit("hall", 20);
  await until(() => receiver.deliveries().length === 3);
  let status: JsonObject = {};
  await until(async () => {
    status = member(member(await subscribe(params), "result"), "deliveryStatus");
    return status["lastDeliveryAt"] !== null;
  });
  assert.equal(status["lastError"], null);
  assert.equal(typeof status["lastDeliveryAt"], "string");
  await handler.close();
});

test("webhook: the server abandons a delivery after the last attempt, keeps the error, and sends the next occurrence", async () => {
  const { handler, subscribe, sensors } = server({ attempts: 3 });
  receiver.answer((request) => (request.body["type"] === undefined && request.body["eventId"] === "reading-0" ? { status: 503 } : undefined));
  const params = { secret: newSecret() };
  assert.ok(isJsonObject((await subscribe(params))["result"]));
  await until(() => sensors.listeners === 1);
  sensors.emit("hall", 20);
  await until(() => receiver.deliveries().length === 3);
  let result: JsonObject = {};
  await until(async () => {
    result = member(await subscribe(params), "result");
    return result["cursor"] === "0";
  });
  assert.equal(member(result, "deliveryStatus")["lastError"], "http_5xx");
  sensors.emit("hall", 21);
  await until(() => receiver.deliveries().length === 4);
  assert.deepEqual(
    receiver.deliveries().map((each) => each.body["eventId"]),
    ["reading-0", "reading-0", "reading-0", "reading-1"],
  );
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

test("webhook: events/unsubscribe of the subscription of another principal gives NotFound", async () => {
  const { handler, rpc, subscribe, sensors } = server();
  await subscribe({ arguments: { room: "hall" } });
  await until(() => sensors.listeners === 1);
  const params = { name: "sensor.reading.changed", arguments: { room: "hall" }, delivery: { url: receiver.url } };
  assert.deepEqual(await rpc("events/unsubscribe", params, "bob").then((answer) => answer["error"]), { code: -32023, message: "There is no such subscription.", data: { kind: "subscription" } });
  assert.equal(sensors.listeners, 1);
  await handler.close();
});

test("webhook: a complete subscription ends with no message", async () => {
  const { handler, subscribe } = server({ maxSubscriptions: 1 });
  assert.ok(isJsonObject((await subscribe({ name: "sensor.ticks" }))["result"]));
  const firstEnded = async () => isJsonObject((await subscribe({}))["result"]);
  await until(firstEnded);
  assert.equal(receiver.deliveries().length, 3);
  await handler.close();
});

test("webhook: parallel new subscriptions of one principal cannot pass the limit together", async () => {
  const { handler, subscribe } = server({ maxSubscriptions: 2 });
  const answers = await Promise.all(["a", "b", "c", "d"].map((room) => subscribe({ arguments: { room }, url: `${receiver.url}?room=${room}` })));
  assert.equal(answers.filter((answer) => isJsonObject(answer["result"])).length, 2);
  assert.equal(answers.filter((answer) => isJsonObject(answer["error"]) && answer["error"]["code"] === -32025).length, 2);
  await handler.close();
});

test("webhook: the verification is for the pair of the principal and the URL as the client sent it", async () => {
  const { handler, subscribe } = server();
  const spelled = receiver.url.replace("https://", "HTTPS://");
  assert.ok(isJsonObject((await subscribe({ arguments: { room: "a" } }))["result"]));
  assert.ok(isJsonObject((await subscribe({ arguments: { room: "b" } }))["result"]));
  assert.ok(isJsonObject((await subscribe({ arguments: { room: "c" }, url: spelled }))["result"]));
  assert.equal(receiver.received.filter((each) => each.body["type"] === "verification").length, 2);
  await handler.close();
});

