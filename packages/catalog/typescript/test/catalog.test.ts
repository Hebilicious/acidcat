import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Catalog } from "../src/index.ts";
import { airconCatalog } from "../examples/aircon.ts";

function expected(path: string): string {
  // Paths are relative to packages/catalog.
  return readFileSync(new URL(`../../${path}`, import.meta.url), "utf-8");
}

test("the library writes the same air-conditioner catalog as Pkl", () => {
  assert.equal(airconCatalog().render(), expected("../../examples/aircon.acidcat.json"));
});

test("the library writes the canonical form of every value", () => {
  const catalog = new Catalog().target("cli", { bindings: ["cli"] }).capability("edge.case.check", {
    description: "Strings: \"quoted\", back\\slash, tab\t, é,  , \u0001, 😀.",
    audience: ["cli"],
    output: {
      type: "object",
      zKey: "last",
      aKey: "first",
      properties: { é: { type: "string" }, z: { type: "string" }, Z: { type: "string" } },
      examples: [
        {
          whole: 16.0,
          half: 0.5,
          tiny: 1e-7,
          small: 0.000001,
          large: 1e21,
          big: 123456789012345680000,
          negative: -2.5e-10,
          zero: 0,
          integer: 42,
        },
      ],
    },
  });
  assert.equal(catalog.render(), expected("fixtures/edge.acidcat.json"));
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
