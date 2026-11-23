import assert from "node:assert/strict";
import { test } from "node:test";

import { decodeMcpHeaderValue, encodeMcpHeaderValue, mcpHeaderMismatch, mcpHeaderProperties, mcpParamHeaders } from "../src/index.ts";

test("a header value is the text, or the base64 sentinel form, as the examples of the Streamable HTTP transport show", () => {
  for (const [text, encoded] of [
    ["us-west1", "us-west1"],
    ["Hello, 世界", "=?base64?SGVsbG8sIOS4lueVjA==?="],
    [" padded ", "=?base64?IHBhZGRlZCA=?="],
    ["line1\nline2", "=?base64?bGluZTEKbGluZTI=?="],
    ["=?base64?literal?=", "=?base64?PT9iYXNlNjQ/bGl0ZXJhbD89?="],
    ["\uFEFFk", "=?base64?77u/aw==?="],
  ] as const) {
    assert.equal(encodeMcpHeaderValue(text), encoded, text);
    assert.equal(decodeMcpHeaderValue(encoded), text, encoded);
  }
  for (const invalid of ["=?base64?not base64?=", "=?base64?/w==?=", "café"]) assert.equal(decodeMcpHeaderValue(invalid), undefined, invalid);
});

const schema = {
  type: "object",
  properties: {
    region: { type: "string", "x-mcp-header": "Region" },
    nested: { type: "object", properties: { on: { type: "boolean", "x-mcp-header": "On" } } },
    count: { type: "integer", "x-mcp-header": "Count" },
    list: { type: "array", items: { type: "object", properties: { ignored: { type: "string", "x-mcp-header": "Ignored" } } } },
    query: { type: "string" },
  },
};

test("only the annotations that a chain of properties keys reaches count, and a client mirrors the values that are present", () => {
  assert.deepEqual(mcpHeaderProperties(schema), [
    { header: "Region", path: ["region"] },
    { header: "On", path: ["nested", "on"] },
    { header: "Count", path: ["count"] },
  ]);
  assert.deepEqual(mcpParamHeaders(schema, { region: "Hello, 世界", nested: { on: false }, count: null, query: "x" }), {
    "Mcp-Param-Region": "=?base64?SGVsbG8sIOS4lueVjA==?=",
    "Mcp-Param-On": "false",
  });
});

test("the headers of a request must agree with its method, its name and its annotated arguments", () => {
  const check = (headers: Record<string, string>, args: unknown, method = "tools/call", name: unknown = "db.query") =>
    mcpHeaderMismatch((header) => new Headers(headers).get(header), method, { name, arguments: args }, schema);
  const named = { "Mcp-Method": "tools/call", "Mcp-Name": "db.query" };
  assert.equal(check({ ...named, "mcp-param-region": "eu", "Mcp-Param-Count": "42" }, { region: "eu", count: 42 }), undefined);
  assert.equal(check({ ...named, "Mcp-Param-Region": "=?base64?ZXU=?=" }, { region: "eu" }), undefined);
  assert.equal(check({ ...named, "Mcp-Name": "=?base64?ZGIucXVlcnk=?=" }, {}), undefined);
  assert.equal(check({ ...named, "Mcp-Param-On": "true" }, { nested: { on: true } }), undefined);
  assert.match(check({ ...named, "Mcp-Method": "tools/list" }, {}) ?? "", /Mcp-Method/);
  assert.match(check({ "Mcp-Method": "tools/call" }, {}) ?? "", /Mcp-Name/);
  assert.match(check({ ...named, "Mcp-Name": "db.other" }, {}) ?? "", /Mcp-Name/);
  assert.match(check(named, {}, "tools/call", null) ?? "", /Mcp-Name/);
  assert.match(check(named, { region: "eu" }) ?? "", /Mcp-Param-Region/);
  assert.match(check({ ...named, "Mcp-Param-Region": "us" }, { region: "eu" }) ?? "", /Mcp-Param-Region/);
  assert.match(check({ ...named, "Mcp-Param-Region": "eu" }, {}) ?? "", /Mcp-Param-Region/);
  assert.match(check({ ...named, "Mcp-Param-Count": "4x" }, { count: 4 }) ?? "", /Mcp-Param-Count/);
  assert.equal(check({ "Mcp-Method": "events/list" }, {}, "events/list", undefined), undefined);
});
