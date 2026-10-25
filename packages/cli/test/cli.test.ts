import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

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

test("a view keeps one target, its capabilities, and only the types they reach", () => {
  const till = viewOf(bakery, "till");
  assert.deepEqual(Object.keys(till.targets), ["till"]);
  assert.deepEqual(Object.keys(till.capabilities).sort(), ["bakery.menu.list", "bakery.order.get", "bakery.price.set"]);
  assert.deepEqual(Object.keys(till.$defs ?? {}).sort(), ["Loaf", "Order", "OrderStatus"]);
  assert.deepEqual(till.capabilities["bakery.order.get"]?.audience, ["till"]);
  assert.deepEqual(check(till), { errors: [], warnings: [] });

  const mcp = viewOf(bakery, "mcp");
  assert.ok("bakery.order.place" in mcp.capabilities);
  assert.ok(!("bakery.price.set" in mcp.capabilities));
  assert.ok(!("bakery.oven.start" in mcp.capabilities));
  assert.deepEqual(Object.keys(mcp.$defs ?? {}).sort(), ["Loaf", "Order", "OrderStatus", "SoldOut"]);
});

test("a view of a target whose capabilities use no type has no $defs", () => {
  const kitchen = viewOf(bakery, "kitchen");
  assert.deepEqual(Object.keys(kitchen.capabilities), ["bakery.oven.start"]);
  assert.equal(kitchen.$defs, undefined);
  assert.deepEqual(check(kitchen), { errors: [], warnings: [] });
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
