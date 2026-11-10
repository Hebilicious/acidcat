import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bundle,
  canonicalJson,
  decodePollCursor,
  encodePollCursor,
  isGloballyRoutable,
  mcpEventEntry,
  webhookGrantMs,
  webhookSecretBytes,
  webhookSignature,
  webhookSubscriptionId,
  CallFailureError,
  cliEventUsage,
  cliExitCode,
  cliJsonArray,
  cliUsage,
  commandPath,
  fail,
  httpEventMessage,
  httpStatus,
  isOccurrence,
  isId,
  isJsonObject,
  mcpEventParams,
  mcpSubscribeError,
  mcpToolResult,
  objectInput,
  occurrenceOf,
  ok,
  readBounded,
  screenRequest,
  viewOf,
  type CatalogDocument,
} from "../src/index.ts";

test("ids become surface names", () => {
  assert.ok(isId("aircon.power.set"));
  assert.ok(!isId("Aircon.power"));
  assert.ok(!isId("aircon"));
  assert.deepEqual(commandPath("aircon.power.set"), ["aircon", "power", "set"]);
});

test("a repeated flag that occurs once with JSON text of an array gives that array", () => {
  assert.deepEqual(cliJsonArray(["[1,2]"]), [1, 2]);
  assert.deepEqual(cliJsonArray(["[]"]), []);
  assert.equal(cliJsonArray(["1"]), undefined);
  assert.equal(cliJsonArray(["mon"]), undefined);
  assert.equal(cliJsonArray(['{"a":1}']), undefined);
  assert.equal(cliJsonArray(["[1,2]", "3"]), undefined);
  assert.equal(cliJsonArray([]), undefined);
});

test("the usage of a command gives its flags, required flags first", () => {
  const input = {
    type: "object",
    required: ["speed", "on"],
    properties: {
      speed: { $ref: "#/$defs/FanSpeed" },
      on: { type: "boolean" },
      note: { type: "string" },
      quiet: { type: "boolean" },
      limits: { type: "array" },
      levels: { type: "array", items: { type: "integer" } },
      speeds: { type: "array", items: { $ref: "#/$defs/FanSpeed" } },
      pairs: { type: "array", items: { type: "array" } },
    },
    $defs: { FanSpeed: { enum: ["auto", "low"] } },
  };
  assert.equal(
    cliUsage("aircon", "aircon.fan.set", { ...input, required: [...input.required, "levels"] }),
    "aircon aircon fan set --levels <integer>... --on --speed <auto|low> [--limits <json>] [--note <string>] [--pairs <json>] [--quiet] [--speeds <auto|low>...]",
  );
  assert.equal(cliUsage("aircon", "aircon.status.get", undefined), "aircon aircon status get");
  assert.equal(cliUsage("aircon", "aircon.status.get", { type: "object", properties: {} }), "aircon aircon status get");
  assert.equal(cliUsage("aircon", "aircon.batch.run", { oneOf: [{ type: "object" }] }), "aircon call aircon.batch.run '<json>'");
});

test("each outcome has its exit code, status code and MCP result", () => {
  const offline = fail({ _tag: "Offline", since: "2026-01-01T00:00:00Z" });
  assert.deepEqual(offline, { ok: false, error: { _tag: "Offline", since: "2026-01-01T00:00:00Z" } });
  assert.equal(cliExitCode(ok(null)), 0);
  assert.equal(cliExitCode(offline), 1);
  assert.equal(cliExitCode({ kind: "invalid-input", message: "" }), 3);
  assert.equal(httpStatus(offline), 200);
  assert.equal(httpStatus({ kind: "unavailable", message: "" }), 503);
  assert.deepEqual(mcpToolResult(ok({ power: true }), true), {
    content: [{ type: "text", text: '{"power":true}' }],
    structuredContent: { power: true },
  });
  assert.deepEqual(mcpToolResult(ok(null), false), { content: [{ type: "text", text: "null" }] });
  assert.equal(mcpToolResult(offline, true).content[0].text, '{"ok":false,"error":{"_tag":"Offline","since":"2026-01-01T00:00:00Z"}}');
  assert.equal(mcpToolResult({ kind: "internal", message: "x" }, true).isError, true);
});

test("a call failure becomes an error with its kind", () => {
  const error = new CallFailureError({ kind: "cancelled", message: "stopped" });
  assert.equal(error.kind, "cancelled");
  assert.equal(error.name, "AbortError");
  assert.equal(new CallFailureError({ kind: "invalid-input", message: "" }).name, "TypeError");
});

test("remote requests are screened in order", async () => {
  const rules = { methods: ["POST"], allowedOrigins: ["https://a.example"], mediaType: "application/json", maximumBytes: 8 };
  const request = (init: RequestInit) => new Request("https://a.example/mcp", init);
  assert.equal(screenRequest(request({ method: "GET" }), rules), "method");
  assert.equal(screenRequest(request({ method: "POST", headers: { Origin: "https://b.example" } }), rules), "origin");
  assert.equal(screenRequest(request({ method: "POST", headers: { "Content-Type": "text/plain" }, body: "x" }), rules), "media-type");
  assert.equal(screenRequest(request({ method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }), rules), undefined);
  assert.deepEqual(await readBounded(request({ method: "POST", body: "123456789" }), 8), { rejection: "too-large" });
  assert.deepEqual(await readBounded(request({ method: "POST", body: new Uint8Array([0xff]) }), 8), { rejection: "not-utf8" });
  assert.deepEqual(await readBounded(request({ method: "POST", body: "{}" }), 8), { text: "{}" });
});

test("views keep one target, and bundles keep the types they use", () => {
  const catalog: CatalogDocument = {
    acidcat: "0.1",
    targets: { app: { bindings: ["typescript"] }, mcp: { bindings: ["mcp"] } },
    $defs: { Mode: { enum: ["cool", "heat"] }, Status: { type: "object", properties: { mode: { $ref: "#/$defs/Mode" } } }, Hidden: { type: "string" } },
    capabilities: {
      "a.status": { description: "x", audience: ["app", "mcp"], output: { $ref: "#/$defs/Status" } },
      "a.hidden": { description: "y", audience: ["app"], output: { $ref: "#/$defs/Hidden" } },
    },
  };
  const view = viewOf(catalog, "mcp");
  assert.deepEqual(Object.keys(view.capabilities), ["a.status"]);
  assert.deepEqual(view.capabilities["a.status"]?.audience, ["mcp"]);
  assert.deepEqual(Object.keys(view.$defs ?? {}).sort(), ["Mode", "Status"]);
  assert.ok(catalog.$defs !== undefined);
  const bundled = bundle({ $ref: "#/$defs/Status" }, catalog.$defs);
  assert.equal(bundled.type, "object");
  assert.ok(isJsonObject(bundled.$defs));
  assert.deepEqual(Object.keys(bundled.$defs), ["Mode"]);
});

test("an input that is a union of objects becomes an object schema", () => {
  const types = { ById: { type: "object", properties: { id: { type: "integer" } } }, Name: { type: "string" } };
  const union = { anyOf: [{ type: "object", properties: { name: { type: "string" } } }, { $ref: "#/$defs/ById" }] };
  assert.deepEqual(objectInput(union, types), { type: "object", ...union });
  assert.deepEqual(objectInput({ oneOf: union.anyOf }, types), { type: "object", oneOf: union.anyOf });
  assert.deepEqual(objectInput({ $ref: "#/$defs/Lookup" }, { ...types, Lookup: union }), { type: "object", $ref: "#/$defs/Lookup" });

  const notObjects = { anyOf: [{ $ref: "#/$defs/ById" }, { $ref: "#/$defs/Name" }] };
  assert.equal(objectInput(notObjects, types), notObjects);
  const object = { type: "object" };
  assert.equal(objectInput(object, types), object);
  const reference = { $ref: "#/$defs/ById" };
  assert.equal(objectInput(reference, types), reference);
});

test("views keep the events of one target, and the types that they use", () => {
  const catalog: CatalogDocument = {
    acidcat: "0.1",
    targets: { app: { bindings: ["typescript"] }, mcp: { bindings: ["mcp"] } },
    $defs: { Status: { type: "object" }, Secret: { type: "object" } },
    capabilities: {},
    events: {
      "a.changed": { description: "x", audience: ["app", "mcp"], payload: { $ref: "#/$defs/Status" } },
      "a.secret": { description: "y", audience: ["app"], payload: { $ref: "#/$defs/Secret" } },
    },
  };
  const view = viewOf(catalog, "mcp");
  assert.deepEqual(Object.keys(view.events ?? {}), ["a.changed"]);
  assert.deepEqual(view.events?.["a.changed"]?.audience, ["mcp"]);
  assert.deepEqual(Object.keys(view.$defs ?? {}), ["Status"]);
  assert.equal("events" in viewOf({ ...catalog, events: { "a.secret": { description: "y", audience: ["app"] } } }, "mcp"), false);
});

test("an emitted value becomes an occurrence", () => {
  const now = () => new Date("2026-11-10T09:30:00.000Z");
  const occurrence = occurrenceOf("a.changed", { data: { n: 1 }, cursor: "1" }, () => "e1", now);
  assert.deepEqual(occurrence, { eventId: "e1", name: "a.changed", timestamp: "2026-11-10T09:30:00.000Z", data: { n: 1 }, cursor: "1" });
  assert.ok(isOccurrence(occurrence));
  assert.equal(occurrenceOf("a.changed", { data: {}, eventId: "x", truncated: true }, () => "e1", now).eventId, "x");
  assert.equal(isOccurrence({ ...occurrence, data: 1 }), false);
  assert.equal(isOccurrence({ ...occurrence, extra: 1 }), false);
  assert.equal(isOccurrence({ ...occurrence, truncated: false }), false);
});

test("occurrences become server-sent events, MCP notifications and CLI usage", () => {
  const occurrence = { eventId: "e1", name: "a.changed", timestamp: "2026-11-10T09:30:00Z", data: {}, cursor: "7", truncated: true } as const;
  assert.equal(httpEventMessage.next(occurrence), `event: next\nid: 7\ndata: ${JSON.stringify(occurrence)}\n\n`);
  assert.equal(httpEventMessage.complete(), "event: complete\ndata:\n\n");
  assert.equal(httpEventMessage.error({ kind: "internal", message: "m" }), 'event: error\ndata: {"kind":"internal","message":"m"}\n\n');
  assert.deepEqual(mcpEventParams(occurrence, 3), {
    eventId: "e1",
    name: "a.changed",
    timestamp: "2026-11-10T09:30:00Z",
    data: {},
    cursor: "7",
    _meta: { "io.modelcontextprotocol/subscriptionId": 3 },
  });
  assert.deepEqual(mcpSubscribeError({ kind: "unknown-capability", message: "m" }), { code: -32023, message: "m", data: { kind: "event" } });
  assert.equal(mcpSubscribeError({ kind: "invalid-input", message: "m" }).code, -32602);
  assert.equal(cliEventUsage("aircon", "aircon.status.changed", { type: "object", properties: {} }), "aircon watch aircon.status.changed [--cursor <string>] [--max-age-ms <integer>]");
  assert.equal(cliEventUsage("x", "a.b", { type: "object" }), "x watch a.b '<json>' [--cursor <string>] [--max-age-ms <integer>]");
  assert.equal(
    cliEventUsage("x", "a.b", { type: "object", required: ["room"], properties: { room: { type: "string" } } }),
    "x watch a.b --room <string> [--cursor <string>] [--max-age-ms <integer>]",
  );
});

test("canonical JSON sorts keys at all levels and has no spaces", () => {
  assert.equal(canonicalJson({ b: [1, { d: 0.5, c: "x" }], a: null }), '{"a":null,"b":[1,{"c":"x","d":0.5}]}');
  assert.equal(canonicalJson("é"), '"é"');
});

test("a poll cursor keeps its lease, position and provider cursor, and other text is not a poll cursor", () => {
  const position = { lease: "l1", position: 7, provider: "c/9" };
  assert.deepEqual(decodePollCursor(encodePollCursor(position)), position);
  assert.deepEqual(decodePollCursor(encodePollCursor({ lease: "l1", position: 0 })), { lease: "l1", position: 0 });
  assert.equal(decodePollCursor("7"), undefined);
  assert.equal(decodePollCursor("p1.!!"), undefined);
  assert.equal(decodePollCursor(`p1.${btoa(JSON.stringify(["l", -1]))}`), undefined);
});

test("events/list gives the delivery modes", () => {
  assert.deepEqual(mcpEventEntry("a.b", "d", undefined, undefined).delivery, ["push", "poll"]);
  assert.deepEqual(mcpEventEntry("a.b", "d", undefined, undefined, true).delivery, ["push", "poll", "webhook"]);
});

test("webhook secrets, grants, signatures and subscription ids follow Standard Webhooks and the MCP binding", async () => {
  const secret = `whsec_${btoa(String.fromCharCode(...Array.from({ length: 24 }, () => 7)))}`;
  assert.equal(webhookSecretBytes(secret)?.length, 24);
  assert.equal(webhookSecretBytes(`whsec_${btoa("short")}`), undefined);
  assert.equal(webhookSecretBytes("secret"), undefined);
  assert.equal(webhookSecretBytes("whsec_not base64!"), undefined);
  const limits = { maxTtlMs: 3_600_000, minTtlMs: 60_000 };
  assert.equal(webhookGrantMs(undefined, limits), 3_600_000);
  assert.equal(webhookGrantMs(null, limits), 3_600_000);
  assert.equal(webhookGrantMs(1000, limits), 60_000);
  assert.equal(webhookGrantMs(120_000, limits), 120_000);
  assert.equal(webhookGrantMs(10 ** 9, limits), 3_600_000);

  // The example of the Standard Webhooks specification.
  const signature = await webhookSignature(["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"], "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}');
  assert.equal(signature, "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");
  assert.equal((await webhookSignature([secret, secret], "msg_x", 1, "{}")).split(" ").length, 2);

  const id = await webhookSubscriptionId("p", "https://h/x", "a.b", { y: 1, x: 2 });
  assert.match(id, /^sub_[0-9a-f]{16}$/);
  assert.equal(await webhookSubscriptionId("p", "https://h/x", "a.b", { x: 2, y: 1 }), id);
  assert.notEqual(await webhookSubscriptionId("q", "https://h/x", "a.b", { x: 2, y: 1 }), id);
});

test("only globally routable addresses are allowed for webhooks", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8"]) assert.ok(isGloballyRoutable(address), address);
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "localhost", "1.2.3", "1.2.3.256",
  ]) {
    assert.equal(isGloballyRoutable(address), false, address);
  }
});
