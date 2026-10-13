import assert from "node:assert/strict";
import { test } from "node:test";

import { Unit } from "../src/aircon.ts";
import { graphqlApi } from "../src/graphql.ts";

const post = (handler: (request: Request) => Promise<Response>, query: string, headers: Record<string, string> = {}) =>
  handler(
    new Request("http://localhost/graphql", {
      method: "POST",
      headers: { "Content-Type": "application/json", ...headers },
      body: JSON.stringify({ query }),
    }),
  ).then(async (response) => ({ status: response.status, body: response.ok ? ((await response.json()) as any) : undefined }));

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
  const poweredOff = await post(api, "mutation { setMode(mode: heat) { mode } }");
  assert.equal(poweredOff.body.errors[0].extensions.code, "PoweredOff");
  const invalid = await post(api, "mutation { setTemperature(celsius: 40) { targetCelsius } }");
  assert.equal(invalid.body.errors[0].extensions.code, "invalid-input");
  unit.change({ online: false });
  assert.equal((await post(api, "{ status { power } }")).body.errors[0].extensions.code, "Offline");
});

test("the HTTP binding is at /api, and a foreign origin is rejected", async () => {
  const api = graphqlApi({ unit: new Unit() });
  const listed = (await (await api(new Request("http://localhost/api/capabilities"))).json()) as { id: string }[];
  assert.deepEqual(listed.map((entry) => entry.id), ["aircon.status.get", "aircon.power.set", "aircon.mode.set", "aircon.temperature.set", "aircon.fan.set"]);
  assert.equal((await post(api, "{ status { power } }", { Origin: "https://example.com" })).status, 403);
});
