import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";

import { printSchema } from "graphql";
import { z } from "zod";

import { Unit } from "../core-ts/aircon.ts";
import { graphqlApi, schema } from "../apis/graphql.ts";

/** A GraphQL response. Each error has the `code` of the call failure in its extensions. */
const GraphQLResponse = z.object({
  data: z.unknown().optional(),
  errors: z.array(z.object({ message: z.string(), extensions: z.looseObject({ code: z.string() }) })).optional(),
});

/** The entries of the list of capabilities of the HTTP binding. */
const CapabilityList = z.array(z.looseObject({ id: z.string() }));

const post = async (handler: (request: Request) => Promise<Response>, query: string, headers: Record<string, string> = {}) => {
  const response = await handler(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query }),
    }),
  );
  return { status: response.status, body: response.ok ? GraphQLResponse.parse(await response.json()) : undefined };
};

/** The code of the first error of a GraphQL response. */
const errorCode = async (response: ReturnType<typeof post>) => (await response).body?.errors?.[0]?.extensions.code;

test("queries and mutations call the capabilities", async () => {
  const unit = new Unit();
  const api = graphqlApi({ unit });
  assert.deepEqual((await post(api, "{ status { ... on Status { power mode targetCelsius } } }")).body, {
    data: { status: { power: false, mode: "cool", targetCelsius: 22 } },
  });
  assert.deepEqual((await post(api, "mutation { setPower(on: true) { ... on Status { power } } }")).body, { data: { setPower: { power: true } } });
  assert.deepEqual((await post(api, "mutation { setMode(mode: heat) { ... on Status { mode } } }")).body, { data: { setMode: { mode: "heat" } } });
  assert.equal(unit.state.mode, "heat");
});

test("a failure is data with its type, and a call failure is an error with its kind", async () => {
  const unit = new Unit();
  const api = graphqlApi({ unit });
  const poweredOff = await post(api, "mutation { setMode(mode: heat) { __typename ... on PoweredOff { _tag } ... on Status { mode } } }");
  assert.deepEqual(poweredOff.body, { data: { setMode: { __typename: "PoweredOff", _tag: "PoweredOff" } } });
  assert.equal(await errorCode(post(api, "mutation { setTemperature(celsius: 40) { __typename } }")), "invalid-input");
  unit.change({ online: false });
  const offline = await post(api, "{ status { __typename ... on Offline { _tag since } } }");
  assert.deepEqual(offline.body, { data: { status: { __typename: "Offline", _tag: "Offline", since: null } } });
});

test("the HTTP binding is at /api, and a foreign origin is rejected", async () => {
  const api = graphqlApi({ unit: new Unit() });
  const listed = CapabilityList.parse(await (await api(new Request("http://localhost/api/capabilities"))).json());
  assert.deepEqual(listed.map((entry) => entry.id), ["aircon.status.get", "aircon.power.set", "aircon.mode.set", "aircon.temperature.set", "aircon.fan.set", "aircon.schedule.set"]);
  assert.equal((await post(api, "{ status { power } }", { Origin: "https://example.com" })).status, 403);
});

test("apis/schema.graphql is the schema of the API", () => {
  const committed = readFileSync(new URL("../apis/schema.graphql", import.meta.url), "utf-8");
  assert.equal(committed, `${printSchema(schema)}\n`, "apis/schema.graphql is stale: run `moon run examples`");
});
