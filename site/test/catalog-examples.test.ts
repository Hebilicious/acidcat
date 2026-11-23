import assert from "node:assert/strict";
import { test } from "node:test";
import { catalogExamples, statementAt } from "../src/lib/catalog-examples.ts";

const repository = new URL("../../", import.meta.url).pathname;

test("a catalog example gives the entry in each source, with JSON last", async () => {
  const examples = await catalogExamples({ capability: "aircon.power.set" }, repository);
  assert.deepEqual(
    examples.map((example) => example.label),
    ["TypeScript", "Python", "Go", "Rust", "Pkl", "JSON"],
  );
  for (const example of examples) assert.match(example.code, /aircon\.power\.set/, example.label);
  for (const example of examples.slice(0, 5)) assert.match(example.code, /setting/, `${example.label} shows the helper that the entry calls`);
  const json: unknown = JSON.parse(examples[5]?.code ?? "");
  assert.ok(typeof json === "object" && json !== null);
  assert.deepEqual(Object.keys(json), ["capabilities"]);
});

test("a catalog example finds targets, types and events", async () => {
  const examples = await catalogExamples({ target: "cli", type: "Status", event: "aircon.status.changed" }, repository);
  for (const example of examples) {
    assert.match(example.code, /"?cli"?/, example.label);
    assert.match(example.code, /Status/, example.label);
    assert.match(example.code, /aircon\.status\.changed/, example.label);
  }
  const pkl = examples.find((example) => example.label === "Pkl");
  assert.match(pkl?.code ?? "", /^targets \{\n {2}\["cli"\] \{/m);
  assert.match(pkl?.code ?? "", /^events \{\n {2}\["aircon\.status\.changed"\] \{/m);
});

test("a catalog example fails when an entry is not in a source", async () => {
  await assert.rejects(catalogExamples({ capability: "aircon.lights.set" }, repository), /has no capability "aircon\.lights\.set"/);
  await assert.rejects(catalogExamples({}, repository), /needs a target, a type, a capability or an event/);
});

test("a statement ends where its brackets close, and not at a bracket in a string", () => {
  const lines = ['call("a)", {', "  value: [1, 2],", "})", "next()"];
  assert.deepEqual(statementAt(lines, 0), lines.slice(0, 3));
  assert.deepEqual(statementAt(["key =", "  value(1)", "other"], 0), ["key =", "  value(1)"]);
  assert.deepEqual(statementAt(["def f():", "    return 1", "", "g()"], 0), ["def f():", "    return 1"]);
});
