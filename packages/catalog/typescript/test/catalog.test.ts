import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Catalog } from "../src/index.ts";
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
      properties: { ü: { type: "string" }, Ü: { type: "string" }, u: { type: "string" }, U: { type: "string" } },
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
