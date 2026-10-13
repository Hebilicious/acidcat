import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { canonicalText } from "@acid-cat/catalog";
import { bundle, check, viewOf, type Catalog } from "../src/catalog.ts";

const aircon = JSON.parse(
  readFileSync(new URL("../../../examples/aircon.acidcat.json", import.meta.url), "utf-8"),
) as Catalog;

test("canonical form does not change a canonical catalog", () => {
  const text = canonicalText(aircon);
  assert.equal(canonicalText(JSON.parse(text)), text);
});

test("a view keeps one target, its capabilities, and only the types they reach", () => {
  const view = viewOf(aircon, "taskbar");
  assert.deepEqual(Object.keys(view.targets), ["taskbar"]);
  assert.deepEqual(Object.keys(view.capabilities).sort(), ["aircon.power.set", "aircon.status.get"]);
  assert.deepEqual(Object.keys(view.$defs ?? {}).sort(), ["FanSpeed", "Mode", "Offline", "Status"]);
  assert.deepEqual(check(view), { errors: [], warnings: [] });

  const firmware = viewOf(aircon, "app");
  assert.ok("aircon.firmware.update" in firmware.capabilities);
  assert.ok(!("aircon.firmware.update" in viewOf(aircon, "mcp").capabilities));
});

test("bundling copies every type a schema reaches, and inlines a bare reference", () => {
  const output = bundle(aircon.capabilities["aircon.status.get"]!.output!, aircon.$defs!);
  assert.equal(output.type, "object");
  assert.deepEqual(Object.keys(output.$defs as object).sort(), ["FanSpeed", "Mode"]);
});

test("a catalog that breaks a rule gets an error", () => {
  const broken = { ...aircon, capabilities: { "a.b": { description: "x", audience: ["nowhere"] } } };
  assert.deepEqual(check(broken).errors, ["a.b: the audience names nowhere, which is not a target"]);
});

test("a catalog that does not match the catalog schema gets an error with its path", () => {
  const broken = { ...aircon, capabilities: { "a.b": { audience: [] } } };
  assert.deepEqual(check(broken).errors, ['["capabilities"]["a.b"]["description"]: Missing key']);
});

test("an unknown member without an x- prefix gets a warning", () => {
  const extended = { ...aircon, "x-icon": "fan", icon: "fan" };
  assert.deepEqual(check(extended).warnings, ["the catalog: unknown member icon; give extensions an x- prefix"]);
});
