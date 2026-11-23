import assert from "node:assert/strict";
import { test } from "node:test";

import {
  bundle,
  byCodePoint,
  canonicalJson,
  cliFlags,
  ownMember,
  resolveType,
  typesUsedBy,
  decodePollCursor,
  encodePollCursor,
  isGloballyRoutable,
  isVersionRange,
  mcpServerCard,
  mcpServerCardDescription,
  mcpServerCardIdentity,
  mcpServerCardName,
  mcpServerCardSettings,
  webhookGrantMs,
  webhookSecretBytes,
  webhookSignature,
  webhookSubscriptionId,
  cliJsonArray,
  cliUsage,
  cliCommandList,
  cliHelp,
  cliAliases,
  isOccurrence,
  isId,
  isJsonObject,
  mcpToolResult,
  objectInput,
  occurrenceOf,
  ok,
  readBounded,
  viewOf,
  type CatalogDocument,
} from "../src/index.ts";

test("an id has two or more lowercase segments", () => {
  assert.ok(isId("aircon.power.set"));
  assert.ok(!isId("Aircon.power"));
  assert.ok(!isId("aircon"));
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

test("the usage of a command reads a $ref, and gives a required repeated flag, an array of $ref items, and JSON text for an array of arrays or with no items", () => {
  const input = {
    type: "object",
    required: ["speed", "levels"],
    properties: {
      speed: { $ref: "#/$defs/FanSpeed" },
      limits: { type: "array" },
      levels: { type: "array", items: { type: "integer" } },
      speeds: { type: "array", items: { $ref: "#/$defs/FanSpeed" } },
      pairs: { type: "array", items: { type: "array" } },
    },
    $defs: { FanSpeed: { enum: ["auto", "low"] } },
  };
  assert.equal(cliUsage("aircon", "aircon.fan.set", input), "aircon aircon fan set --levels <integer>... --speed <auto|low> [--limits <json>] [--pairs <json>] [--speeds <auto|low>...]");
});

test("the help of a command, and the command list of a shared prefix, in the order of the capabilities", () => {
  assert.equal(cliHelp("aircon aircon power set --on", "Turn the unit on or off."), "Usage: aircon aircon power set --on\n\nTurn the unit on or off.");
  const capabilities = [
    { id: "aircon.status.get", usage: "aircon aircon status get" },
    { id: "aircon.power.set", usage: "aircon aircon power set --on" },
    { id: "aircon.status.export", usage: "aircon aircon status export --path <string>" },
  ];
  assert.equal(cliCommandList(["aircon", "status"], capabilities), "Commands:\n  aircon aircon status get\n  aircon aircon status export --path <string>");
  assert.equal(cliCommandList(["aircon"], capabilities), "Commands:\n  aircon aircon status get\n  aircon aircon power set --on\n  aircon aircon status export --path <string>");
  assert.equal(cliCommandList(["aircon", "power", "set"], capabilities), undefined);
  assert.equal(cliCommandList(["aircon", "fan"], capabilities), undefined);
  assert.equal(cliCommandList([], capabilities), undefined);
});

test("a value of a tool with no output schema has no structured content", () => {
  assert.deepEqual(mcpToolResult(ok(null), false), { content: [{ type: "text", text: "null" }] });
});

test("a request body one byte over the limit is too large", async () => {
  const request = (body: string) => new Request("https://a.example/mcp", { method: "POST", body });
  assert.deepEqual(await readBounded(request("123456789"), 8), { rejection: "too-large" });
  assert.deepEqual(await readBounded(request("12345678"), 8), { text: "12345678" });
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
  const list = { type: "object", properties: { modes: { type: "array", items: { $ref: "#/$defs/Mode" } } } };
  const bundledList = bundle(list, catalog.$defs);
  assert.deepEqual(bundledList.properties, list.properties);
  assert.ok(isJsonObject(bundledList.$defs));
  assert.deepEqual(Object.keys(bundledList.$defs), ["Mode"]);
});

test("inherited names, such as constructor and toString, are not targets or types", () => {
  const catalog: CatalogDocument = {
    acidcat: "0.1",
    targets: { app: { bindings: ["typescript"] } },
    capabilities: { "a.status": { description: "x", audience: ["app"], output: { $ref: "#/$defs/toString" } } },
  };
  const view = viewOf(catalog, "constructor");
  assert.deepEqual(view.targets, {});
  assert.deepEqual(view.capabilities, {});
  assert.equal(typesUsedBy({ $ref: "#/$defs/toString" }, {}).size, 0);
  assert.equal(viewOf(catalog, "app").$defs, undefined);
  assert.equal(ownMember({}, "constructor"), undefined);
  assert.deepEqual(bundle({ $ref: "#/$defs/valueOf" }, {}), { $ref: "#/$defs/valueOf" });
  assert.deepEqual(resolveType({ $ref: "#/$defs/hasOwnProperty" }, {}), { $ref: "#/$defs/hasOwnProperty" });
});

test("a schema resolves to the type that its $ref refers to, whatever other keys it has", () => {
  const types = { Item: { type: "object" } };
  assert.equal(resolveType({ $ref: "#/$defs/Item", title: "GetItemInput" }, types), types.Item);
  assert.equal(resolveType({ $ref: "#/$defs/Item" }, types), types.Item);
  const plain = { type: "string" };
  assert.equal(resolveType(plain, types), plain);
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

test("canonical JSON sorts keys at all levels and has no spaces", () => {
  assert.equal(canonicalJson({ b: [1, { d: 0.5, c: "x" }], a: null }), '{"a":null,"b":[1,{"c":"x","d":0.5}]}');
  assert.equal(canonicalJson("é"), '"é"');
  // U+FF61 is after U+1F408 in UTF-16 code units, and before it in code points.
  assert.equal(canonicalJson({ "🐈": 1, "｡": 2, "10": 3, "9": 4 }), '{"10":3,"9":4,"｡":2,"🐈":1}');
  assert.ok(byCodePoint("｡", "🐈") < 0);
  assert.deepEqual(cliFlags({ type: "object", properties: { "🐈": { type: "boolean" }, "｡": { type: "boolean" } } }), ["[--｡]", "[--🐈]"]);
});

test("a poll cursor keeps its lease, position and provider cursor, and other text is not a poll cursor", () => {
  const position = { lease: "l1", position: 7, provider: "c/9" };
  assert.deepEqual(decodePollCursor(encodePollCursor(position)), position);
  assert.deepEqual(decodePollCursor(encodePollCursor({ lease: "l1", position: 0 })), { lease: "l1", position: 0 });
  assert.equal(decodePollCursor("7"), undefined);
  assert.equal(decodePollCursor("p1.!!"), undefined);
  assert.equal(decodePollCursor(`p1.${btoa(JSON.stringify(["l", -1]))}`), undefined);
});

test("webhook secrets, grants, signatures and subscription ids follow Standard Webhooks and the MCP binding", async () => {
  assert.equal(webhookSecretBytes("whsec_not base64!"), undefined);
  assert.equal(webhookGrantMs(120_000, { maxTtlMs: 3_600_000, minTtlMs: 60_000 }), 120_000);

  // The example of the Standard Webhooks specification.
  const signature = await webhookSignature(["whsec_MfKQ9r8GKYqrTwjUPD8ILPZIo2LaLaSw"], "msg_p5jXN8AQM9LWM0D4loKWxJek", 1614265330, '{"test": 2432232314}');
  assert.equal(signature, "v1,g0hM9SsE+OTPJTGt/tmIKtSyZlE3uFJELVlNIOLJ1OE=");

  const id = await webhookSubscriptionId("p", "https://h/x", "a.b", { y: 1, x: 2 });
  assert.match(id, /^sub_[0-9a-f]{16}$/);
  assert.equal(await webhookSubscriptionId("p", "https://h/x", "a.b", { x: 2, y: 1 }), id);
  assert.notEqual(await webhookSubscriptionId("q", "https://h/x", "a.b", { x: 2, y: 1 }), id);
});

test("only globally routable addresses are allowed for webhooks", () => {
  for (const address of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111", "::ffff:8.8.8.8", "2001:200::1", "3fff:1000::1"]) assert.ok(isGloballyRoutable(address), address);
  for (const address of [
    "127.0.0.1", "10.1.2.3", "172.16.0.1", "192.168.1.1", "169.254.169.254", "100.64.0.1", "0.0.0.0", "224.0.0.1", "255.255.255.255",
    "192.0.2.1", "198.51.100.1", "203.0.113.1", "198.18.0.1", "::1", "::", "fe80::1", "fc00::1", "fd12::1", "ff02::1", "2001:db8::1",
    "::ffff:127.0.0.1", "::ffff:10.0.0.1", "64:ff9b::a00:1", "2001:1ff::1", "3fff:fff::1", "localhost", "1.2.3", "1.2.3.256",
  ]) {
    assert.equal(isGloballyRoutable(address), false, address);
  }
});

test("cliAliases reads the input schema of a capability through $defs, and ignores a target that is not in the catalog", () => {
  const catalog = {
    acidcat: "0.1",
    targets: { cli: { bindings: ["cli"], options: { cli: { aliases: { "--on": { capability: "aircon.power.set", input: { on: true } }, loud: { capability: "aircon.power.set", input: { volume: 1 } } } } } } },
    $defs: { Power: { type: "object", required: ["on"], properties: { on: { type: "boolean" } } } },
    capabilities: { "aircon.power.set": { description: "", audience: ["cli"], input: { $ref: "#/$defs/Power" } } },
  } as const;
  assert.deepEqual(cliAliases(catalog, "cli"), {
    aliases: [{ name: "--on", kind: "capability", id: "aircon.power.set", input: { on: true } }],
    default: undefined,
    errors: ["target cli: the alias loud has the fixed input volume, which is not a property of the input of aircon.power.set"],
  });
  assert.deepEqual(cliAliases(catalog, "api"), { aliases: [], default: undefined, errors: [] });
});

test("a version range is not a version of a Server Card", () => {
  for (const range of ["^1.2.3", "~1.2.3", ">=1.2.3", "<2", "=1.0.0", "1.x", "1.2.*", "*", "1 - 2", "1.2 || 1.3"]) assert.equal(isVersionRange(range), true, range);
  for (const version of ["1.2.3", "2.1.0-alpha", "1.0.0-next.1", "1.0.0+x", "0.0.0", "v1.2"]) assert.equal(isVersionRange(version), false, version);
});

test("the default name of a Server Card reverses the labels of the host, and falls back to local for an IP address", () => {
  const cases = [
    ["aircon.example.com", "aircon", "com.example.aircon/aircon"],
    ["Aircon.Example.COM.", "aircon", "com.example.aircon/aircon"],
    ["aircon.example.com:8443", "aircon", "com.example.aircon/aircon"],
    ["localhost", "aircon", "localhost/aircon"],
    ["localhost:3000", "aircon", "localhost/aircon"],
    ["127.0.0.1:3000", "aircon", "local/aircon"],
    ["[::1]:3000", "aircon", "local/aircon"],
    ["[2001:db8::1]", "aircon", "local/aircon"],
    ["", "aircon", "local/aircon"],
    ["my_host.example.com", "air con/é🙂", "com.example.my-host/air-con---"],
    ["example.com", "", "com.example/mcp"],
    [`${"a".repeat(100)}.com`, "aircon", "local/aircon"],
    ["example.com", "n".repeat(150), `com.example/${"n".repeat(100)}`],
  ] as const;
  for (const [host, name, expected] of cases) assert.equal(mcpServerCardName(host, name), expected, `${host} ${name}`);
});

test("a given URL of a Server Card is an absolute http or https URL with a host, and gives the default name with the host in ASCII", () => {
  const cases = [
    ["https://bücher.example/mcp", "example.xn--bcher-kva/aircon"],
    ["https://BÜCHER.Example:8443/mcp", "example.xn--bcher-kva/aircon"],
    ["http://0x7f.1/mcp", "local/aircon"],
    ["http://[::1]:3000/mcp", "local/aircon"],
    ["http://user:pw@host.example/x", "example.host/aircon"],
    ["http://%", undefined],
    ["https://a b/mcp", undefined],
    ["https://example.com/a b", undefined],
    ["ftp://example.com/mcp", undefined],
    ["mailto:a@b.c", undefined],
    ["file:///x", undefined],
    ["http://", undefined],
  ] as const;
  for (const [url, name] of cases) {
    if (name === undefined) {
      assert.throws(() => mcpServerCardSettings({ url }, false), /absolute http or https URL with a host/u, url);
      continue;
    }
    const identity = mcpServerCardIdentity({ url }, { name: "aircon", version: "1.0.0", descriptions: [] });
    const card = mcpServerCard(identity, "http://request.example/mcp", undefined);
    assert.equal(card["name"], name, url);
  }
});

test("the default description of a Server Card is the first text that is not empty, shortened to 100 characters", () => {
  assert.equal(mcpServerCardDescription(["The catalog.", "The instructions.", "aircon"]), "The catalog.");
  assert.equal(mcpServerCardDescription([undefined, "", "The instructions.", "aircon"]), "The instructions.");
  assert.equal(mcpServerCardDescription([undefined, undefined, "aircon"]), "aircon");
  assert.equal(mcpServerCardDescription([undefined, ""]), "MCP server");
  assert.equal(mcpServerCardDescription(["é".repeat(100)]), "é".repeat(100));
  assert.equal(mcpServerCardDescription(["🙂".repeat(101)]), `${"🙂".repeat(99)}…`);
});
