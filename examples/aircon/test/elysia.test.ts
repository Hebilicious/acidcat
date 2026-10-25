import assert from "node:assert/strict";
import { test } from "node:test";

import { z } from "zod";

import { Unit } from "../core-ts/aircon.ts";
import { elysiaApi } from "../apis/elysia.ts";

const request = (path: string, init: { method?: string; body?: unknown; origin?: string } = {}) =>
  new Request(`http://localhost${path}`, {
    method: init.method ?? "GET",
    headers: { "Content-Type": "application/json", ...(init.origin === undefined ? {} : { Origin: init.origin }) },
    ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
  });

test("the routes of the application call the capabilities", async () => {
  const unit = new Unit();
  const app = elysiaApi({ unit });
  const changed = await app.handle(request("/status", { method: "PATCH", body: { power: true, mode: "heat", targetCelsius: 24 } }));
  assert.equal(changed.status, 200);
  assert.deepEqual(await changed.json(), { power: true, mode: "heat", fan: "auto", targetCelsius: 24, roomCelsius: 25 });
  assert.deepEqual(await (await app.handle(request("/status"))).json(), unit.status.getSnapshot());
});

test("a failure gives 409, a call failure its status, and a bad body 422", async () => {
  const unit = new Unit();
  const app = elysiaApi({ unit });
  const poweredOff = await app.handle(request("/status", { method: "PATCH", body: { mode: "heat", fan: "high" } }));
  assert.equal(poweredOff.status, 409);
  assert.deepEqual(await poweredOff.json(), { _tag: "PoweredOff" });
  assert.equal(unit.state.fan, "auto", "the failure stops the settings after it");
  const invalid = await app.handle(request("/status", { method: "PATCH", body: { targetCelsius: 40 } }));
  assert.equal(invalid.status, 422);
  const { kind } = z.object({ kind: z.string(), message: z.string() }).parse(await invalid.json());
  assert.equal(kind, "invalid-input");
  assert.equal((await app.handle(request("/status", { method: "PATCH", body: { mode: "warm" } }))).status, 422);
});

test("the HTTP binding is mounted at /api, and a foreign origin is rejected", async () => {
  const unit = new Unit();
  const app = elysiaApi({ unit });
  const response = await app.handle(request("/api/capabilities/aircon.power.set", { method: "POST", body: { on: true } }));
  assert.deepEqual(await response.json(), { ok: true, value: null });
  assert.equal(unit.state.power, true);
  assert.equal((await app.handle(request("/status", { origin: "https://example.com" }))).status, 403);
});
