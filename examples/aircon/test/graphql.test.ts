import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import { Unit } from "../core-ts/aircon.ts";
import { graphqlApi } from "../apis/graphql.ts";

/** A GraphQL response. Each error has the `code` of the failure or of the call failure in its extensions. */
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
  assert.deepEqual((await post(api, "{ status { power mode targetCelsius } }")).body, {
    data: { status: { power: false, mode: "cool", targetCelsius: 22 } },
  });
  assert.deepEqual((await post(api, "mutation { setPower(on: true) { power } }")).body, { data: { setPower: { power: true } } });
  assert.deepEqual((await post(api, "mutation { setMode(mode: heat) { mode } }")).body, { data: { setMode: { mode: "heat" } } });
  assert.equal(unit.state.mode, "heat");
});

test("a failure and a call failure give their code", async () => {
  const unit = new Unit();
  const api = graphqlApi({ unit });
  assert.equal(await errorCode(post(api, "mutation { setMode(mode: heat) { mode } }")), "PoweredOff");
  assert.equal(await errorCode(post(api, "mutation { setTemperature(celsius: 40) { targetCelsius } }")), "invalid-input");
  unit.change({ online: false });
  assert.equal(await errorCode(post(api, "{ status { power } }")), "Offline");
});

test("the HTTP binding is at /api, and a foreign origin is rejected", async () => {
  const api = graphqlApi({ unit: new Unit() });
  const listed = CapabilityList.parse(await (await api(new Request("http://localhost/api/capabilities"))).json());
  assert.deepEqual(listed.map((entry) => entry.id), ["aircon.status.get", "aircon.power.set", "aircon.mode.set", "aircon.temperature.set", "aircon.fan.set"]);
  assert.equal((await post(api, "{ status { power } }", { Origin: "https://example.com" })).status, 403);
});
