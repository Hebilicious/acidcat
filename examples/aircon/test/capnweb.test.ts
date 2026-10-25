import assert from "node:assert/strict";
import { after, before, test } from "node:test";

import { serve } from "@acid-cat/cli";
import type { Served } from "@acid-cat/cli";
import { newHttpBatchRpcSession } from "capnweb";

import { Unit } from "../core-ts/aircon.ts";
import { capnwebApi } from "../apis/capnweb.ts";
import type { AirconApi } from "../apis/capnweb.ts";

const unit = new Unit();
let served: Served;
before(async () => {
  const api = capnwebApi({ unit });
  served = await serve({ "/rpc": api, "/api": api });
});
after(() => served.close());

/** A batch: the calls that a client makes before it waits go in one request. */
const client = () => newHttpBatchRpcSession<AirconApi>(`${served.url}/rpc`);

test("methods give the results of the capabilities", async () => {
  assert.deepEqual(await client().setMode("heat"), { ok: false, error: { _tag: "PoweredOff" } });
  const batch = client();
  const [power, status] = await Promise.all([batch.setPower(true), batch.status()]);
  assert.deepEqual(power, { ok: true, value: null });
  assert.equal(status.ok, true);
  assert.deepEqual(await client().setMode("heat"), { ok: true, value: null });
  assert.equal(unit.state.mode, "heat");
});

test("a call failure rejects", async () => {
  await assert.rejects(async () => await client().setTemperature(40), (error: Error) => error.message.includes("celsius"));
});

test("the HTTP binding is at /api", async () => {
  const response = await fetch(`${served.url}/api/capabilities/aircon.fan.set`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ speed: "high" }),
  });
  assert.deepEqual(await response.json(), { ok: true, value: null });
  assert.equal(unit.state.fan, "high");
});
