import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { cliAliases, isJsonObject } from "../src/index.ts";
import type { CatalogDocument, JsonObject } from "../src/index.ts";

const member = (value: unknown, key: string): unknown => {
  if (!isJsonObject(value) || !Object.hasOwn(value, key)) throw new Error(`The case has no member ${key}: ${JSON.stringify(value)}`);
  return value[key];
};

const items = (value: unknown): readonly unknown[] => {
  if (!Array.isArray(value)) throw new Error(`The case member is not a list: ${JSON.stringify(value)}`);
  return value;
};

const text = (value: unknown): string => {
  if (typeof value !== "string") throw new Error(`The case member is not a string: ${JSON.stringify(value)}`);
  return value;
};

const entries = (value: unknown, target: string) =>
  Object.fromEntries(
    items(value).map((entry) => {
      const input = member(entry, "input");
      return [
        text(member(entry, "id")),
        { description: "", audience: member(entry, "inTarget") === true ? [target] : [], ...(isJsonObject(input) ? { input } : {}) },
      ];
    }),
  );

const fixture: unknown = JSON.parse(readFileSync(new URL("fixtures/cli-alias-cases.json", import.meta.url), "utf8"));
const target = text(member(fixture, "target"));
const capabilities = entries(member(fixture, "capabilities"), target);
const events = entries(member(fixture, "events"), target);

const catalogOf = (testCase: unknown): CatalogDocument => {
  const options: JsonObject = isJsonObject(testCase) && Object.hasOwn(testCase, "settings") ? { cli: testCase.settings } : {};
  const surfaces = member(testCase, "surface") === true ? ["cli"] : [];
  return { acidcat: "0.1", targets: { [target]: { surfaces, options } }, capabilities, events };
};

test("cliAliases gives the errors, the aliases and the default alias of the model in each case", () => {
  const cases = items(member(fixture, "cases"));
  assert.ok(cases.length > 0);
  for (const testCase of cases) {
    const result = cliAliases(catalogOf(testCase), target);
    const actual = { errors: result.errors, aliases: result.aliases, default: result.default?.name ?? null };
    const expected = { errors: member(testCase, "errors"), aliases: member(testCase, "aliases"), default: member(testCase, "default") };
    assert.deepEqual(actual, expected, JSON.stringify(testCase));
  }
});
