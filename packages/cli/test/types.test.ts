import assert from "node:assert/strict";
import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { test } from "node:test";
import { fileURLToPath } from "node:url";

import type { Catalog } from "../src/catalog.ts";
import type { JsonObject } from "../src/json.ts";
import { typescriptTypes } from "../src/typescript.ts";

const main = fileURLToPath(new URL("../src/main.ts", import.meta.url));
const bakeryFile = fileURLToPath(new URL("./fixtures/bakery.acidcat.json", import.meta.url));
const tsc = fileURLToPath(new URL("../node_modules/.bin/tsc", import.meta.url));

const catalogWith = (parts: Partial<Catalog>): Catalog => ({ acidcat: "0.1", targets: { app: { bindings: ["typescript"] } }, capabilities: {}, ...parts });

function textOf(catalog: Catalog): string {
  const types = typescriptTypes(catalog);
  assert.ok(types.ok, types.ok ? "" : types.errors.join("\n"));
  return types.text;
}

function errorsOf(catalog: Catalog): readonly string[] {
  const types = typescriptTypes(catalog);
  assert.ok(!types.ok, "the catalog has types");
  return types.errors;
}

function declared(text: string, name: string): string | undefined {
  return new RegExp(`export type ${name} = ?([\\s\\S]*?);\\n(?:\\n|$)`).exec(text)?.[1];
}

const typeOf = (schema: JsonObject, types: { readonly [name: string]: JsonObject } = {}) =>
  declared(textOf(catalogWith({ $defs: { ...types, T: schema } })), "T");

const acidCat = (...args: string[]) => spawnSync(process.execPath, [main, ...args], { encoding: "utf-8" });

test("references, the empty schema and the schema with no values become a name, unknown and never", () => {
  assert.equal(typeOf({ $ref: "#/$defs/A" }, { A: { type: "string" } }), "A");
  assert.equal(typeOf({}), "unknown");
  assert.equal(typeOf({ not: {} }), "never");
});

test("const and enum become literals, and only the literals that the type accepts", () => {
  assert.equal(typeOf({ const: "a" }), '"a"');
  assert.equal(typeOf({ enum: ["a", 1, null, true] }), '"a" | 1 | null | true');
  assert.equal(typeOf({ type: "integer", enum: ["a", 1, 1.5] }), "1");
  assert.equal(typeOf({ const: { a: [1] } }), "{ readonly a: readonly [1] }");
});

test("each JSON type becomes its TypeScript type, and an array of types becomes a union", () => {
  assert.equal(typeOf({ type: ["string", "integer", "number", "boolean", "null"] }), "string | number | boolean | null");
});

test("an object keeps its required and optional properties, and has an index signature only when other properties can match no declared property", () => {
  const schema = { type: "object", required: ["a", "b-c"], properties: { a: { type: "string" }, "b-c": { type: "number" }, d: { type: "boolean" } } };
  assert.equal(typeOf(schema), '{ readonly a: string; readonly "b-c": number; readonly d?: boolean }');
  assert.equal(typeOf({ ...schema, additionalProperties: false }), '{ readonly a: string; readonly "b-c": number; readonly d?: boolean }');
  assert.equal(typeOf({ type: "object", additionalProperties: { type: "number" } }), "{ readonly [key: string]: number }");
  assert.equal(typeOf({ type: "object" }), "{ readonly [key: string]: unknown }");
  assert.equal(typeOf({ type: "object", properties: {}, additionalProperties: false }), "{ readonly [key: string]: never }");
  assert.equal(typeOf({ type: "object", required: ["x"] }), "{ readonly x: unknown }");
  assert.equal(typeOf({ type: "object", properties: { a: { type: "string" } } }), "{ readonly a?: string; readonly [key: string]: unknown }");
  assert.equal(typeOf({ type: "object", properties: { a: { type: "string" } }, additionalProperties: false }), "{ readonly a?: string }");
});

test("an array becomes a readonly array, and prefixItems a tuple whose items are optional after minItems", () => {
  assert.equal(typeOf({ type: "array", items: { type: ["string", "null"] } }), "readonly (string | null)[]");
  assert.equal(typeOf({ type: "array" }), "readonly unknown[]");
  assert.equal(typeOf({ type: "array", prefixItems: [{ type: "string" }, { type: "number" }], minItems: 1 }), "readonly [string, number?, ...unknown[]]");
  assert.equal(typeOf({ type: "array", prefixItems: [{ type: "string" }], items: { type: "boolean" } }), "readonly [string?, ...boolean[]]");
  assert.equal(typeOf({ type: "array", prefixItems: [{ type: "string" }], items: false }), "readonly [string?]");
});

test("anyOf and oneOf become a union, and allOf an intersection", () => {
  assert.equal(typeOf({ anyOf: [{ type: "string" }, { type: "null" }] }), "string | null");
  assert.equal(typeOf({ oneOf: [{ const: 1 }, { const: 2 }] }), "1 | 2");
  assert.equal(typeOf({ allOf: [{ $ref: "#/$defs/A" }, { $ref: "#/$defs/B" }] }, { A: {}, B: { type: "object" } }), "A & B");
});

test("a keyword that the types cannot express makes the type wider, never narrower", () => {
  assert.equal(typeOf({ type: "string", not: { const: "a" }, pattern: "^b", minLength: 1 }), "string");
  assert.equal(typeOf({ if: { type: "string" }, else: { type: "number" } }), "unknown");
  assert.equal(typeOf({ properties: { a: { type: "string" } } }), "unknown");
  assert.equal(typeOf({ type: "object", patternProperties: { "^x-": {} }, additionalProperties: false }), "{ readonly [key: string]: unknown }");
});

test("a description becomes a JSDoc comment on the type and on the property", () => {
  const schema = { description: "A */ B", type: "object", properties: { a: { description: "Line one.\nLine two.", type: "string" } } };
  const text = textOf(catalogWith({ $defs: { T: schema } }));
  assert.match(text, /\/\*\* A \*\\\/ B \*\/\nexport type T = \{\n {2}\/\*\*\n {3}\* Line one\.\n {3}\* Line two\.\n {3}\*\/\n {2}readonly a\?: string;\n/);
});

test("a capability gives its input, value, failure and state, and the Capabilities interface maps its id to them", () => {
  const text = textOf(
    catalogWith({
      $defs: { Offline: { type: "object", properties: { since: { type: "string" } } } },
      capabilities: {
        "fixture.hold-on": { description: "Hold.", input: { type: "object", properties: {} } },
        "unit.status.get": {
          description: "Read the status.",
          output: { type: "boolean" },
          failures: { Offline: { $ref: "#/$defs/Offline" }, Busy: { description: "Busy now.", type: "object", additionalProperties: false } },
          state: { type: "boolean" },
        },
      },
    }),
  );
  assert.equal(declared(text, "FixtureHoldOnInput"), "{ readonly [key: string]: never }");
  assert.equal(declared(text, "FixtureHoldOnValue"), "null");
  assert.equal(declared(text, "FixtureHoldOnFailure"), "never");
  assert.equal(declared(text, "FixtureHoldOnState"), undefined);
  assert.equal(declared(text, "UnitStatusGetInput"), "{ readonly [key: string]: never }");
  assert.equal(declared(text, "UnitStatusGetValue"), "boolean");
  assert.equal(declared(text, "UnitStatusGetFailure"), '\n  /** Busy now. */\n  | { readonly _tag: "Busy" }\n  | ({ readonly _tag: "Offline" } & Offline)');
  assert.equal(declared(text, "UnitStatusGetState"), "boolean");
  assert.match(text, /\/\*\* Read the status\. \*\/\n {2}readonly "unit\.status\.get": \{\n {4}readonly input: UnitStatusGetInput;\n {4}readonly value: UnitStatusGetValue;\n {4}readonly failure: UnitStatusGetFailure;\n {4}readonly state: UnitStatusGetState;\n {2}\};/);
  assert.doesNotMatch(text, /interface Events/);
});

test("an event gives its input and payload, an empty object when it has none, and the Events interface", () => {
  const text = textOf(catalogWith({ events: { "unit.status.changed": { description: "It changed.", input: { type: "object", properties: {} } } } }));
  assert.equal(declared(text, "UnitStatusChangedInput"), "{ readonly [key: string]: never }");
  assert.equal(declared(text, "UnitStatusChangedPayload"), "{ readonly [key: string]: never }");
  assert.match(text, /export interface Events \{\n {2}\/\*\* It changed\. \*\/\n {2}readonly "unit\.status\.changed": \{\n {4}readonly input: UnitStatusChangedInput;\n {4}readonly payload: UnitStatusChangedPayload;\n {2}\};\n\}\n$/);
});

test("an inline schema with a title becomes a named type, used once for each schema", () => {
  const point = { title: "Point", description: "A point.", type: "object", properties: { x: { type: "number" } } };
  const text = textOf(catalogWith({ capabilities: { "map.point.move": { description: "Move.", input: point, output: point } } }));
  assert.equal(declared(text, "Point"), "{ readonly x?: number; readonly [key: string]: unknown }");
  assert.equal(text.match(/export type Point /g)?.length, 1);
  assert.match(text, /\/\*\* A point\. \*\/\nexport type Point /);
  assert.equal(declared(text, "MapPointMoveInput"), "Point");
  assert.equal(declared(text, "MapPointMoveValue"), "Point");
});

test("a titled input with no properties takes no properties, and the same titled output stays open", () => {
  const box = { title: "Box", type: "object", properties: {} };
  const text = textOf(catalogWith({ capabilities: { "map.box.echo": { description: "Echo.", input: box, output: box } } }));
  assert.equal(declared(text, "Box"), "{ readonly [key: string]: unknown }");
  assert.equal(declared(text, "MapBoxEchoInput"), "Box & { readonly [key: string]: never }");
  assert.equal(declared(text, "MapBoxEchoValue"), "Box");
});

test("a title that is not a TypeScript name, or that names another type, is an error", () => {
  const output = (title: string) => ({ "map.point.get": { description: "Get.", output: { title, type: "object" } } });
  assert.deepEqual(errorsOf(catalogWith({ capabilities: output("Two words") })), ['map.point.get output: the title "Two words" is not a TypeScript name']);
  assert.deepEqual(errorsOf(catalogWith({ $defs: { Point: { type: "string" } }, capabilities: output("Point") })), [
    "two types have the name Point: type Point in $defs and the title in map.point.get output",
  ]);
  assert.deepEqual(errorsOf(catalogWith({ capabilities: output("MapPointGetInput") })), [
    "two types have the name MapPointGetInput: the input of capability map.point.get and the title in map.point.get output",
  ]);
  assert.equal(declared(textOf(catalogWith({ $defs: { Point: { type: "object" } }, capabilities: output("Point") })), "MapPointGetValue"), "Point");
});

test("two ids or types that give the same name are an error", () => {
  const capabilities = { "a.b-c": { description: "One." }, "a-b.c": { description: "Two." } };
  assert.deepEqual(errorsOf(catalogWith({ capabilities })), [
    "two types have the name ABCInput: the input of capability a-b.c and the input of capability a.b-c",
    "two types have the name ABCValue: the value of capability a-b.c and the value of capability a.b-c",
    "two types have the name ABCFailure: the failure of capability a-b.c and the failure of capability a.b-c",
  ]);
  assert.deepEqual(errorsOf(catalogWith({ $defs: { Capabilities: {}, string: {} } })), [
    'type string in $defs: "string" is not a TypeScript name',
    "two types have the name Capabilities: type Capabilities in $defs and the interface of the capabilities",
  ]);
});

test("the types compile with --strict and --isolatedDeclarations, and accept the values that the schemas accept", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "acid-cat-types-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const result = acidCat("types", "typescript", bakeryFile);
  assert.equal(result.status, 0, result.stderr);
  writeFileSync(join(directory, "bakery.ts"), result.stdout);
  const shapes = {
    Tuple: { type: "array", prefixItems: [{ type: "string" }, { type: "integer" }], items: { type: "boolean" } },
    Open: { type: "object", required: ["a"], properties: { a: { enum: ["x", 2] }, "b c": { type: ["null", "array"], items: { $ref: "#/$defs/Tuple" } } } },
    Map: { type: "object", additionalProperties: { anyOf: [{ type: "string" }, { $ref: "#/$defs/Open" }] } },
    Both: { allOf: [{ $ref: "#/$defs/Open" }, { type: "object", properties: { c: { const: true } } }] },
    Optional: { type: "object", properties: { a: { type: "string" } } },
  };
  writeFileSync(join(directory, "shapes.ts"), textOf(catalogWith({ $defs: shapes })));
  writeFileSync(
    join(directory, "values.ts"),
    [
      'import type { BakeryOrderPlaceFailure, BakeryOrderPlaceInput, BakeryOrderReadyInput, Capabilities, Order } from "./bakery.ts";',
      'import type { Both, Map, Open, Optional, Tuple } from "./shapes.ts";',
      'const withNote = { id: "1", loaf: "rye", quantity: 2, status: "ready", note: "extra" } as const;',
      "export const order: Order = withNote;",
      'export const input: BakeryOrderPlaceInput = { loaf: "brioche", quantity: 1 };',
      'export const failure: BakeryOrderPlaceFailure = { _tag: "SoldOut", loaf: "rye" };',
      "export const filter: BakeryOrderReadyInput = {};",
      'export const value: Capabilities["bakery.menu.list"]["value"] = { loaves: ["rye", "baguette"] };',
      'export const tuples: readonly Tuple[] = [[], ["a"], ["a", 1], ["a", 1, true, false]];',
      'export const open: Open = { a: "x", "b c": [["a", 1]] };',
      'export const map: Map = { one: "a", two: { a: 2, "b c": null } };',
      'export const both: Both = { a: 2, c: true };',
      "const other = { other: 2 } as const;",
      "export const optional: Optional = other;",
      "// @ts-expect-error A loaf that the enum does not accept.",
      'export const wrong: BakeryOrderPlaceInput = { loaf: "bun", quantity: 1 };',
      "",
    ].join("\n"),
  );
  const compiled = spawnSync(
    tsc,
    ["--ignoreConfig", "--noEmit", "--strict", "--exactOptionalPropertyTypes", "--isolatedDeclarations", "--declaration", "--module", "nodenext", "--allowImportingTsExtensions", ...["bakery.ts", "shapes.ts", "values.ts"].map((file) => join(directory, file))],
    { encoding: "utf-8" },
  );
  assert.equal(compiled.status, 0, compiled.stdout + compiled.stderr);
});

test("types typescript writes the same bytes on each run", () => {
  const first = acidCat("types", "typescript", bakeryFile);
  assert.equal(first.status, 0, first.stderr);
  assert.equal(acidCat("types", "typescript", bakeryFile).stdout, first.stdout);
  assert.ok(first.stdout.startsWith("// Written by `acid-cat types typescript`. Do not change this file by hand.\n\n"));
  assert.ok(first.stdout.endsWith("}\n") && !first.stdout.endsWith("\n\n"));
});

test("types typescript --target writes only the types of the view of the target", () => {
  const result = acidCat("types", "typescript", bakeryFile, "--target", "till");
  assert.equal(result.status, 0, result.stderr);
  const names = [...result.stdout.matchAll(/^export (?:type|interface) (\w+)/gm)].map(([, name]) => name);
  assert.deepEqual(names, [
    "Loaf",
    "Order",
    "OrderStatus",
    ...["BakeryMenuList", "BakeryOrderGet", "BakeryPriceSet"].flatMap((prefix) => [`${prefix}Input`, `${prefix}Value`, `${prefix}Failure`]),
    "BakeryOrderReadyInput",
    "BakeryOrderReadyPayload",
    "Capabilities",
    "Events",
  ]);
});

test("types typescript fails with exit code 1 for an unknown target, a file that is not a catalog, and an unknown language", (t) => {
  const directory = mkdtempSync(join(tmpdir(), "acid-cat-types-"));
  t.after(() => rmSync(directory, { recursive: true, force: true }));
  const notCatalog = join(directory, "other.json");
  writeFileSync(notCatalog, JSON.stringify({ name: "other" }));

  const target = acidCat("types", "typescript", bakeryFile, "--target", "garden");
  assert.deepEqual([target.status, target.stdout, target.stderr], [1, "", `${bakeryFile}: error: there is no target garden\n`]);
  const other = acidCat("types", "typescript", notCatalog);
  assert.deepEqual([other.status, other.stdout, other.stderr], [1, "", `${notCatalog}: error: the file is not a catalog; run \`acid-cat check ${notCatalog}\`\n`]);
  const rust = acidCat("types", "rust", bakeryFile);
  assert.equal(rust.status, 1);
  assert.match(rust.stderr, /Unknown subcommand "rust"/);
  const none = acidCat("types");
  assert.deepEqual([none.status, none.stderr], [1, "Give a language: acid-cat types typescript <catalog.json>\n"]);
});
