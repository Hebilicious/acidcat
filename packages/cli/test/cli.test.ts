import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import { check, targetCatalog, type Catalog } from "../src/catalog.ts";
import { bundledProgram } from "./bundled-program.ts";

const isCatalog = (value: unknown): value is Catalog => check(value).errors.length === 0;

const bakeryText = readFileSync(new URL("./fixtures/bakery.acidcat.json", import.meta.url), "utf-8");
const bakery: Catalog = (() => {
  const parsed: unknown = JSON.parse(bakeryText);
  if (!isCatalog(parsed)) throw new Error("test/fixtures/bakery.acidcat.json is not a catalog.");
  return parsed;
})();

test("the catalog of each target conforms", () => {
  for (const target of Object.keys(bakery.targets)) assert.deepEqual(check(targetCatalog(bakery, target)), { errors: [], warnings: [] }, target);
});

const rejected: Readonly<Record<string, readonly string[]>> = {
  "cli-alias.json": [
    "target shop: the alias --buy has the fixed input count, which is not a property of the input of shop.item.buy",
    "target shop: the alias gone refers to shop.item.gone, which is not a capability in the catalog of the target",
    "target shop: the alias list has the name of a command or a flag of the command line",
    "target shop: the first word of the alias list x is the name of a command of the command line",
    "target shop: the alias odd has the unknown member extra",
  ],
  "cli-alias-name.json": [
    '["targets"]["shop"]["options"]["cli"]["aliases"]["Shop"]: Expected a string matching the RegExp ^(--[a-z][a-z0-9]*(-[a-z0-9]+)*|[a-z][a-z0-9]*(-[a-z0-9]+)*( [a-z][a-z0-9]*(-[a-z0-9]+)*)?)$',
    '["targets"]["shop"]["options"]["cli"]["aliases"]["a b c"]: Expected a string matching the RegExp ^(--[a-z][a-z0-9]*(-[a-z0-9]+)*|[a-z][a-z0-9]*(-[a-z0-9]+)*( [a-z][a-z0-9]*(-[a-z0-9]+)*)?)$',
  ],
  "capability-hint-not-boolean.json": ['["capabilities"]["shop.item.remove"]["destructive"]: Expected boolean'],
  "audience-inherited-name.json": ["shop.item.get: the audience names constructor, which is not a target"],
  "event-audience.json": ["shop.order.ready: the audience names till, which is not a target"],
  "event-id-is-a-capability.json": ["shop.order.ready: the id is both a capability and an event"],
  "event-own-defs.json": [
    "shop.order.ready payload has its own $defs; put shared types in the catalog's $defs",
    "shop.order.ready payload references #/$defs/Id, which is not a type",
  ],
  "event-not-object.json": ["shop.loaf.baked: the input is not an object", "shop.loaf.baked: the payload is not an object"],
  "mcp-header-location.json": [
    "shop.order.place input: the x-mcp-header at the root is not on a property that a chain of properties members reaches from the root",
    "shop.order.place input: the x-mcp-header at /properties/item/anyOf/0 is not on a property that a chain of properties members reaches from the root",
    "shop.order.place input: the x-mcp-header at /properties/count/allOf/0 is not on a property that a chain of properties members reaches from the root",
    "shop.order.place input: the x-mcp-header at /properties/lines/items/properties/sku is not on a property that a chain of properties members reaches from the root",
    "shop.order.place input: the x-mcp-header at /$defs/Till is not on a property that a chain of properties members reaches from the root",
    "shop.order.ready input: the x-mcp-header at /properties/shops/items is not on a property that a chain of properties members reaches from the root",
  ],
  "mcp-header-value.json": [
    "shop.order.place input: the x-mcp-header at /properties/price is on a property whose type is not string, integer or boolean",
    'shop.order.place input: the x-mcp-header at /properties/note is "", which is not an HTTP token',
    'shop.order.place input: the x-mcp-header at /properties/shop is "Shop Name", which is not an HTTP token',
    'shop.order.place input: the x-mcp-header at /properties/address/properties/region is "region", which the x-mcp-header at /properties/region already names without regard to case',
  ],
  "event-payload-schema.json": ['["events"]["shop.order.ready"]["payload"]["$ref"]: Missing key'],
  "output-boolean.json": ['["capabilities"]["shop.item.get"]["output"]: Expected schema'],
  "reference-inherited-name.json": ["shop.item.get output references #/$defs/toString, which is not a type"],
};

for (const [file, errors] of Object.entries(rejected)) {
  test(`check rejects ${file}`, () => {
    const document: unknown = JSON.parse(readFileSync(new URL(`./fixtures/rejected/${file}`, import.meta.url), "utf-8"));
    assert.deepEqual(check(document).errors, errors);
  });
}

test("target rejects a target name that only an object inherits, such as constructor", () => {
  const main = bundledProgram("src/main.ts");
  const fixture = fileURLToPath(new URL("./fixtures/bakery.acidcat.json", import.meta.url));
  const result = spawnSync(process.execPath, [main, "target", fixture, "constructor"], { encoding: "utf-8" });
  assert.equal(result.status, 1);
  assert.equal(result.stdout, "");
  assert.match(result.stderr, /there is no target constructor/);
});

test("a first -- is not an argument", () => {
  const main = bundledProgram("src/main.ts");
  const fixture = fileURLToPath(new URL("./fixtures/bakery.acidcat.json", import.meta.url));
  const result = spawnSync(process.execPath, [main, "--", "check", fixture], { encoding: "utf-8" });
  assert.equal(result.status, 0, result.stderr);
  assert.equal(result.stdout, "The catalog conforms.\n");
});

test("a catalog that does not match the catalog schema gets an error with its path", () => {
  const broken = { ...bakery, capabilities: { "a.b": { audience: [] } } };
  assert.deepEqual(check(broken).errors, ['["capabilities"]["a.b"]["description"]: Missing key']);
});

test("an unknown member of the catalog, an event or options.cli without an x- prefix gets a warning, and other members of options get none", () => {
  const events = { "bakery.order.ready": { description: "x", audience: ["shop"], "x-icon": "bell", icon: "bell" } };
  const cli = { aliases: { start: { capability: "bakery.oven.start" } }, default: "start", "x-color": "red", defualt: "start" };
  const kitchen = { ...bakery.targets.kitchen, options: { cli, mcp: { color: "red" } } };
  const extended = { ...bakery, "x-logo": "wheat", logo: "wheat", events, targets: { ...bakery.targets, kitchen } };
  assert.deepEqual(check(extended), {
    errors: [],
    warnings: [
      "the catalog: unknown member logo; give extensions an x- prefix",
      "target kitchen options.cli: unknown member defualt; give extensions an x- prefix",
      "bakery.order.ready: unknown member icon; give extensions an x- prefix",
    ],
  });
});

test("a file in canonical form gets no warning, and a file that is not gets a warning", () => {
  assert.deepEqual(check(bakery, bakeryText), { errors: [], warnings: [] });
  const report = check(bakery, JSON.stringify(bakery));
  assert.deepEqual(report.errors, []);
  assert.deepEqual(report.warnings, ["the file is not in canonical form: run `acid-cat format --write`"]);
});

test("check with --output json writes the report of each catalog, also one that cannot be read, to standard output, and keeps the exit code", () => {
  const main = bundledProgram("src/main.ts");
  const fixture = fileURLToPath(new URL("./fixtures/bakery.acidcat.json", import.meta.url));
  const rejected = fileURLToPath(new URL("./fixtures/rejected/output-boolean.json", import.meta.url));
  const rejectedText = readFileSync(rejected, "utf-8");
  const missing = fileURLToPath(new URL("./fixtures/missing.acidcat.json", import.meta.url));
  const result = spawnSync(process.execPath, [main, "check", "--output", "json", fixture, rejected, missing], { encoding: "utf-8" });
  assert.equal(result.status, 1);
  assert.equal(result.stderr, "");
  const report: unknown = JSON.parse(result.stdout);
  assert.deepEqual(report, {
    conforms: false,
    catalogs: [
      { file: fixture, errors: [], warnings: [] },
      { file: rejected, ...check(JSON.parse(rejectedText), rejectedText) },
      { file: missing, errors: [`the file cannot be read: NotFound: FileSystem.readFile (${missing})`], warnings: [] },
    ],
  });
});
