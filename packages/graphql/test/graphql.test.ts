import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { AVAILABLE, callFailure, fail, ok, viewOf } from "@acid-cat/spec";
import type { CatalogDocument, Outcome } from "@acid-cat/spec";

import { executable, execute, graphqlSchema, readRequest } from "../src/index.ts";
import type { Provider } from "../src/index.ts";

const catalog = JSON.parse(readFileSync(new URL("../../../examples/aircon.acidcat.json", import.meta.url), "utf-8")) as CatalogDocument;
const view = viewOf(catalog, "api");

/** A provider that answers each id with a fixed outcome. */
const provider = (outcomes: Record<string, Outcome<unknown, unknown>>): Provider => ({
  view,
  availability: async () => AVAILABLE,
  invoke: async (id) => outcomes[id] ?? callFailure("unknown-capability", `There is no capability ${id}.`),
});

const run = (outcomes: Record<string, Outcome<unknown, unknown>>, query: string, variables?: Record<string, unknown>) =>
  execute(executable(view), provider(outcomes), { query, variables }, new AbortController().signal);

test("read-only capabilities are queries, and the others are mutations", () => {
  const { operations } = graphqlSchema(view);
  assert.equal(operations.get("aircon.status.get")?.root, "Query");
  assert.equal(operations.get("aircon.power.set")?.root, "Mutation");
  assert.equal(operations.get("aircon.status.get")?.field, "airconStatusGet");
});

test("a value is the value type of the union", async () => {
  const status = { power: true, mode: "heat", fan: "auto", targetCelsius: 22, roomCelsius: 25 };
  const result = await run({ "aircon.status.get": ok(status) }, "{ airconStatusGet { __typename ... on Status { power mode } } }");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { data: { airconStatusGet: { __typename: "Status", power: true, mode: "heat" } } });
});

test("a value that is not an object is in the value field", async () => {
  const result = await run({ "aircon.power.set": ok(null) }, "mutation { airconPowerSet(input: { on: true }) { __typename ... on AirconPowerSetValue { value } } }");
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { data: { airconPowerSet: { __typename: "AirconPowerSetValue", value: null } } });
});

test("a failure is a failure type of the union", async () => {
  const result = await run(
    { "aircon.mode.set": fail("PoweredOff") },
    "mutation { airconModeSet(input: { mode: heat }) { __typename ... on AirconModeSetPoweredOff { _tag } } }",
  );
  assert.deepEqual(JSON.parse(JSON.stringify(result)), { data: { airconModeSet: { __typename: "AirconModeSetPoweredOff", _tag: "PoweredOff" } } });
});

test("a call failure is an error with its kind, and the field is null", async () => {
  const result = await run({ "aircon.power.set": callFailure("unavailable", "The unit is offline.") }, "mutation { airconPowerSet(input: { on: true }) { __typename } }");
  assert.equal(result.data?.airconPowerSet, null);
  assert.equal(result.errors?.[0]?.extensions?.kind, "unavailable");
  assert.equal(result.errors?.[0]?.message, "The unit is offline.");
});

test("acidcatInvoke gives the outcome in its JSON form", async () => {
  const result = await run({ "aircon.mode.set": fail("PoweredOff") }, 'mutation { acidcatInvoke(id: "aircon.mode.set", input: { mode: "heat" }) }');
  assert.deepEqual(result.data?.acidcatInvoke, { ok: false, error: { _tag: "PoweredOff" } });
});

test("requests are read and screened", async () => {
  const request = (init: RequestInit) => readRequest(new Request("https://x.example/graphql", init), { allowedOrigins: [] });
  assert.equal(((await request({ method: "GET" })) as Response).status, 405);
  assert.equal(((await request({ method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" })) as Response).status, 415);
  assert.deepEqual(await request({ method: "POST", headers: { "Content-Type": "application/json" }, body: '{"query":"{ a }"}' }), { query: "{ a }" });
});
