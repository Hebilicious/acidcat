import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Catalog, canonicalText } from "../src/index.ts";
import { libraryCatalog } from "../examples/library.ts";

/** Reads a file. The path is relative to this package. */
function expected(path: string): string {
  return readFileSync(new URL(`../${path}`, import.meta.url), "utf-8");
}

test("the library writes the lending-library catalog in canonical form", () => {
  assert.equal(libraryCatalog().render(), expected("examples/library.acidcat.json"));
});

test("the library writes the canonical form of every value", () => {
  const catalog = new Catalog().target("shell", { bindings: ["cli"] }).capability("edge.values.write", {
    description: "Text: \"quotes\", a\\b, line\nbreak, bell\u0007, unit\u001f, del\u007f, para , ü, 🐈.",
    audience: ["shell"],
    output: {
      type: "object",
      yLast: "y",
      bFirst: "b",
      properties: { ü: { type: "string" }, Ü: { type: "string" }, u: { type: "string" }, U: { type: "string" }, "9": { type: "string" }, "10": { type: "string" } },
      examples: [
        {
          whole: 250.0,
          quarter: 0.25,
          tiny: 4e-9,
          small: 0.0000035,
          large: 7.5e22,
          big: 98765432109876540000,
          negative: -1.5e-12,
          integer: 7,
          zero: 0,
        },
      ],
    },
  });
  assert.equal(catalog.render(), expected("test/fixtures/edge.acidcat.json"));
});

test("the library reports the catalog rules a catalog breaks", () => {
  const catalog = new Catalog()
    .target("cli", { bindings: ["cli"] })
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
  const catalog = new Catalog().target("cli", { bindings: ["cli"] });
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
  const catalog = new Catalog().target("cli", { bindings: ["cli"] });
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

test("the canonical form puts events after capabilities, and the members of an event in order", () => {
  const text = canonicalText({
    events: { "z.b.changed": { payload: { type: "object" }, input: { type: "object" }, description: "b" }, "z.a.changed": { description: "a" } },
    capabilities: {},
    targets: {},
    acidcat: "0.1",
  });
  const expectedText = `{
  "acidcat": "0.1",
  "targets": {},
  "capabilities": {},
  "events": {
    "z.a.changed": {
      "description": "a"
    },
    "z.b.changed": {
      "description": "b",
      "input": {
        "type": "object"
      },
      "payload": {
        "type": "object"
      }
    }
  }
}
`;
  assert.equal(text, expectedText);
});

test("a catalog with no events has no events member", () => {
  const catalog = new Catalog().target("cli", { bindings: ["cli"] }).capability("a.b", { description: "x", audience: ["cli"] });
  assert.equal("events" in catalog.toJSON(), false);
});
