import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { canonicalText } from "@acid-cat/catalog";
import { bundle, check, viewOf, type Catalog } from "../src/catalog.ts";

/** A value is a catalog when the catalog checks give no errors. */
const isCatalog = (value: unknown): value is Catalog => check(value).errors.length === 0;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

/** The test catalog: a bakery, in canonical form. */
const bakeryText = readFileSync(new URL("./fixtures/bakery.acidcat.json", import.meta.url), "utf-8");
const bakery: Catalog = (() => {
  const parsed: unknown = JSON.parse(bakeryText);
  if (!isCatalog(parsed)) throw new Error("test/fixtures/bakery.acidcat.json is not a catalog.");
  return parsed;
})();

test("the test catalog is in canonical form and conforms", () => {
  assert.equal(canonicalText(bakery), bakeryText);
  assert.deepEqual(check(bakery, bakeryText), { errors: [], warnings: [] });
});

test("canonical form does not change a canonical catalog", () => {
  const text = canonicalText(bakery);
  assert.equal(canonicalText(JSON.parse(text)), text);
});

test("canonical form sorts members and keeps the order of arrays", () => {
  const { capabilities, targets, ...rest } = bakery;
  const text = canonicalText({ capabilities, ...rest, targets });
  assert.equal(text, bakeryText);
});

test("canonical form sorts integer-like keys by code point, as other keys", () => {
  const options = { a: 1, "10": 2, "9": 3 };
  const text = canonicalText({ ...bakery, targets: { shop: { bindings: ["typescript"], options } } });
  assert.match(text, /"options": \{\n\s+"10": 2,\n\s+"9": 3,\n\s+"a": 1\n/);
});

test("a view keeps one target, its capabilities, and only the types they reach", () => {
  const till = viewOf(bakery, "till");
  assert.deepEqual(Object.keys(till.targets), ["till"]);
  assert.deepEqual(Object.keys(till.capabilities).sort(), ["bakery.menu.list", "bakery.order.get", "bakery.price.set"]);
  assert.deepEqual(Object.keys(till.$defs ?? {}).sort(), ["Loaf", "Order", "OrderStatus"]);
  assert.deepEqual(till.capabilities["bakery.order.get"]?.audience, ["till"]);
  assert.deepEqual(Object.keys(till.events ?? {}), ["bakery.order.ready"]);
  assert.deepEqual(till.events?.["bakery.order.ready"]?.audience, ["till"]);
  assert.deepEqual(check(till), { errors: [], warnings: [] });

  const mcp = viewOf(bakery, "mcp");
  assert.ok("bakery.order.place" in mcp.capabilities);
  assert.ok(!("bakery.price.set" in mcp.capabilities));
  assert.ok(!("bakery.oven.start" in mcp.capabilities));
  assert.equal(mcp.events, undefined);
  assert.deepEqual(Object.keys(mcp.$defs ?? {}).sort(), ["Loaf", "Order", "OrderStatus", "SoldOut"]);
});

test("a view of a target whose capabilities use no type has no $defs", () => {
  const kitchen = viewOf(bakery, "kitchen");
  assert.deepEqual(Object.keys(kitchen.capabilities), ["bakery.oven.start"]);
  assert.equal(kitchen.$defs, undefined);
  assert.deepEqual(check(kitchen), { errors: [], warnings: [] });
});

test("a view keeps the types that only an event reaches", () => {
  const types = { Order: { type: "object" }, Loaf: { enum: ["rye"] } };
  const catalog: Catalog = {
    ...bakery,
    $defs: types,
    capabilities: {},
    events: { "bakery.order.ready": { description: "x", audience: ["shop"], payload: { $ref: "#/$defs/Order" } } },
  };
  const shop = viewOf(catalog, "shop");
  assert.deepEqual(Object.keys(shop.$defs ?? {}), ["Order"]);
  assert.deepEqual(Object.keys(shop.events ?? {}), ["bakery.order.ready"]);
});

test("bundling copies every type a schema reaches, and inlines a bare reference", () => {
  const output = bakery.capabilities["bakery.order.get"]?.output;
  assert.ok(output !== undefined);
  const bundled = bundle(output, bakery.$defs ?? {});
  assert.equal(bundled.type, "object");
  assert.equal(bundled.$ref, undefined);
  assert.ok(isRecord(bundled.$defs));
  assert.deepEqual(Object.keys(bundled.$defs).sort(), ["Loaf", "OrderStatus"]);
});

test("bundling keeps a schema that is not a bare reference, and adds the types it reaches", () => {
  const output = bakery.capabilities["bakery.menu.list"]?.output;
  assert.ok(output !== undefined);
  const bundled = bundle(output, bakery.$defs ?? {});
  assert.deepEqual(bundled.properties, output.properties);
  assert.ok(isRecord(bundled.$defs));
  assert.deepEqual(Object.keys(bundled.$defs), ["Loaf"]);
});

test("a catalog that breaks a rule gets an error", () => {
  const broken = { ...bakery, capabilities: { "a.b": { description: "x", audience: ["nowhere"] } } };
  assert.deepEqual(check(broken).errors, ["a.b: the audience names nowhere, which is not a target"]);
});

/** The catalogs that `check` rejects (test/fixtures/rejected), with the errors that each one gets. */
const rejected: Readonly<Record<string, readonly string[]>> = {
  "audience-inherited-name.json": ["shop.item.get: the audience names constructor, which is not a target"],
  "event-audience.json": ["shop.order.ready: the audience names till, which is not a target"],
  "event-id-is-a-capability.json": ["shop.order.ready: the id is both a capability and an event"],
  "event-input-not-object.json": ["shop.loaf.baked: the input is not an object"],
  "event-own-defs.json": [
    "shop.order.ready payload has its own $defs; put shared types in the catalog's $defs",
    "shop.order.ready payload references #/$defs/Id, which is not a type",
  ],
  "event-payload-not-object.json": ["shop.loaf.baked: the payload is not an object"],
  "event-payload-schema.json": ['["events"]["shop.order.ready"]["payload"]["$ref"]: Missing key'],
  "event-reference.json": ["shop.order.ready payload references #/$defs/Order, which is not a type"],
  "output-boolean.json": ['["capabilities"]["shop.item.get"]["output"]: Expected schema'],
  "reference-inherited-name.json": ["shop.item.get output references #/$defs/toString, which is not a type"],
};

for (const [file, errors] of Object.entries(rejected)) {
  test(`check rejects ${file}`, () => {
    const document: unknown = JSON.parse(readFileSync(new URL(`./fixtures/rejected/${file}`, import.meta.url), "utf-8"));
    assert.deepEqual(check(document).errors, errors);
  });
}

test("an input that refers to an object type is an object, whatever other keys it has", () => {
  const catalog = {
    ...bakery,
    $defs: { Item: { type: "object" } },
    capabilities: { "shop.item.get": { description: "Get.", audience: ["shop"], input: { $ref: "#/$defs/Item", title: "GetItemInput" } } },
    events: { "shop.item.changed": { description: "Changed.", audience: ["shop"], payload: { $ref: "#/$defs/Item", title: "ItemChanged" } } },
  };
  assert.deepEqual(check(catalog).errors, []);
});

test("view rejects a target name that only an object inherits, such as constructor", () => {
  const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
  const fixture = fileURLToPath(new URL("./fixtures/bakery.acidcat.json", import.meta.url));
  const result = spawnSync(process.execPath, [main, "view", fixture, "constructor"], { encoding: "utf-8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /there is no target constructor/);
});

test("an unknown member of an event without an x- prefix gets a warning", () => {
  const events = { "bakery.order.ready": { description: "x", audience: ["shop"], "x-icon": "bell", icon: "bell" } };
  assert.deepEqual(check({ ...bakery, events }).warnings, ["bakery.order.ready: unknown member icon; give extensions an x- prefix"]);
});

test("a catalog that does not match the catalog schema gets an error with its path", () => {
  const broken = { ...bakery, capabilities: { "a.b": { audience: [] } } };
  assert.deepEqual(check(broken).errors, ['["capabilities"]["a.b"]["description"]: Missing key']);
});

test("an unknown member without an x- prefix gets a warning", () => {
  const extended = { ...bakery, "x-logo": "wheat", logo: "wheat" };
  assert.deepEqual(check(extended).warnings, ["the catalog: unknown member logo; give extensions an x- prefix"]);
});

test("a file that is not in canonical form gets a warning", () => {
  const report = check(bakery, JSON.stringify(bakery));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, ["the file is not in canonical form: run `acid-cat format --write`"]);
});
