import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Catalog, canonicalText } from "../src/index.ts";
import { libraryCatalog } from "../examples/library.ts";

function expected(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");
}

test("the library writes the lending-library catalog in canonical form", () => {
  assert.equal(libraryCatalog().render(), expected("examples/library.acidcat.json"));
});

test("the canonical form writes every value of the shared test catalog", () => {
  const input: unknown = JSON.parse(expected("../testdata/canonical.json"));
  assert.equal(canonicalText(input), expected("../testdata/canonical.acidcat.json"));
});

test("the library writes the hints of a capability in canonical order", () => {
  const catalog = new Catalog().target("agents", { surfaces: ["mcp"] }).capability("notes.count.read", {
    state: { type: "integer" },
    idempotent: true,
    destructive: false,
    readOnly: true,
    audience: ["agents"],
    description: "Read the number of notes.",
  });
  assert.equal(catalog.render(), expected("../testdata/hints.acidcat.json"));
});

test("the library reports the catalog rules a catalog breaks", () => {
  const catalog = new Catalog()
    .target("cli", { surfaces: ["cli"] })
    .capability("Bad.Id", { description: "x" })
    .capability("a.b", { description: "y", audience: ["clii"] })
    .capability("a.c", { description: "z", input: { type: "string" } })
    .capability("a.d", { description: "w", output: { $ref: "#/$defs/Nope" } });
  assert.deepEqual(catalog.validate(), [
    "the id Bad.Id is malformed",
    "a.b names the undeclared target clii",
    "a.c input does not describe an object",
    "a.d references #/$defs/Nope, which is not a type",
  ]);
  assert.throws(() => catalog.render(), /does not conform/);
});

test("the library reports the catalog rules an event breaks", () => {
  const catalog = new Catalog().target("cli", { surfaces: ["cli"] });
  catalog.type("Name", { type: "string" });
  catalog
    .capability("a.b", { description: "x" })
    .event("a.b", { description: "y" })
    .event("a.c", { description: "z", audience: ["clii"], input: { type: "string" } })
    .event("a.d", { description: "w", payload: { $ref: "#/$defs/Name" } })
    .event("a.e", { description: "v", payload: { type: "object", $defs: {} } });
  assert.deepEqual(catalog.validate(), [
    "a.b is both a capability and an event",
    "a.c names the undeclared target clii",
    "a.c input does not describe an object",
    "a.d payload does not describe an object",
    "a.e carries its own $defs; declare shared types with type()",
  ]);
});

test("the library reports a boolean schema", () => {
  const catalog = new Catalog().target("cli", { surfaces: ["cli"] });
  // @ts-expect-error A schema in a catalog is an object, not a boolean.
  catalog.type("Anything", true);
  catalog.capability("a.b", {
    description: "x",
    // @ts-expect-error A schema in a catalog is an object, not a boolean.
    input: true,
    // @ts-expect-error A schema in a catalog is an object, not a boolean.
    output: true,
    // @ts-expect-error A schema in a catalog is an object, not a boolean.
    failures: { Gone: false },
    // @ts-expect-error A schema in a catalog is an object, not a boolean.
    state: true,
  });
  // @ts-expect-error A schema in a catalog is an object, not a boolean.
  catalog.event("a.c", { description: "y", input: false, payload: true });
  catalog.capability("a.d", { description: "z", output: { type: "object", additionalProperties: false, items: true } });
  assert.deepEqual(catalog.validate(), [
    "the type Anything is not a JSON object",
    "a.b input is not a JSON object",
    "a.b output is not a JSON object",
    "a.b state is not a JSON object",
    "a.b failure Gone is not a JSON object",
    "a.c input is not a JSON object",
    "a.c payload is not a JSON object",
  ]);
  assert.throws(() => catalog.render());
});
