import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { Catalog } from "../src/index.ts";
import { airconCatalog } from "../examples/aircon.ts";

test("the SDK writes the same air-conditioner catalog as Pkl", () => {
  const expected = JSON.parse(readFileSync(new URL("../../../examples/aircon.acidcat.json", import.meta.url), "utf-8"));
  assert.deepEqual(JSON.parse(airconCatalog().render()), expected);
});

test("the SDK reports the catalog rules a catalog breaks", () => {
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
