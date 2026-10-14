import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bundle,
  CallFailureError,
  cliExitCode,
  cliUsage,
  commandPath,
  fail,
  httpStatus,
  isId,
  mcpToolResult,
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
    },
    $defs: { FanSpeed: { enum: ["auto", "low"] } },
  };
  assert.equal(cliUsage("aircon", "aircon.fan.set", input), "aircon aircon fan set --on --speed <auto|low> [--limits <json>] [--note <string>] [--quiet]");
  assert.equal(cliUsage("aircon", "aircon.status.get", undefined), "aircon aircon status get");
  assert.equal(cliUsage("aircon", "aircon.status.get", { type: "object", properties: {} }), "aircon aircon status get");
  assert.equal(cliUsage("aircon", "aircon.batch.run", { oneOf: [{ type: "object" }] }), "aircon call aircon.batch.run '<json>'");
});

test("each outcome has its exit code, status code and MCP result", () => {
  const offline = fail("Offline", { since: "2026-01-01T00:00:00Z" });
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
  assert.deepEqual(view.capabilities["a.status"]!.audience, ["mcp"]);
  assert.deepEqual(Object.keys(view.$defs ?? {}).sort(), ["Mode", "Status"]);
  const bundled = bundle({ $ref: "#/$defs/Status" }, catalog.$defs!);
  assert.equal(bundled.type, "object");
  assert.deepEqual(Object.keys(bundled.$defs as object), ["Mode"]);
});
