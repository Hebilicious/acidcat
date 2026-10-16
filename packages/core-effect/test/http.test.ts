import assert from "node:assert/strict";
import { test } from "node:test";

import { Deferred, Effect, Layer } from "effect";

import { Http } from "../src/index.ts";
import { countedFixtureLayer, fixture, fixtureLayer, heldApp, recordingApp } from "./fixture.ts";

const ORIGIN = "https://fixture.example";
const handler = Http.toWebHandler(fixture, Layer.fresh(fixtureLayer), { allowedOrigins: [ORIGIN], base: "/api" });

const post = (id: string, body: unknown, headers: HeadersInit = { "Content-Type": "application/json" }) =>
  handler(new Request(`${ORIGIN}/api/capabilities/${id}`, { method: "POST", headers, body: JSON.stringify(body) }));

test("GET /capabilities lists the view with availability", async () => {
  const response = await handler(new Request(`${ORIGIN}/api/capabilities`));
  const list = (await response.json()) as { id: string; available: boolean }[];
  assert.equal(response.status, 200);
  assert.ok(list.some((entry) => entry.id === "fixture.echo" && entry.available));
  assert.ok(!list.some((entry) => entry.id === "fixture.hidden"));
});

test("POST gives each outcome its status code", async () => {
  const value = await post("fixture.echo", { text: "hi" });
  assert.equal(value.status, 200);
  assert.deepEqual(await value.json(), { ok: true, value: { text: "hi" } });

  const failure = await post("fixture.refuse", {});
  assert.equal(failure.status, 200);
  assert.deepEqual(await failure.json(), { ok: false, error: { _tag: "Refused", reason: "No." } });

  assert.equal((await post("fixture.echo", { text: 1 })).status, 422);
  assert.equal((await post("fixture.hidden", {})).status, 404);
  assert.equal((await post("fixture.crash", {})).status, 500);
});

test("GET /catalog gives the view", async () => {
  const view = (await (await handler(new Request(`${ORIGIN}/api/catalog`))).json()) as { targets: object };
  assert.deepEqual(Object.keys(view.targets), ["api"]);
});

test("requests are rejected before the body is read", async () => {
  assert.equal((await handler(new Request(`${ORIGIN}/api/capabilities`, { method: "PUT" }))).status, 405);
  assert.equal((await post("fixture.echo", {}, { "Content-Type": "application/json", Origin: "https://evil.example" })).status, 403);
  assert.equal((await post("fixture.echo", {}, { "Content-Type": "text/plain" })).status, 415);
});

test("with per-request services, each request that passes the screening has its own services", async () => {
  const { counts, layer } = countedFixtureLayer();
  const perRequest = Http.toWebHandler(fixture, layer, { allowedOrigins: [ORIGIN], base: "/api", services: "per-request" });
  const toggle = async () => {
    const list = (await (await perRequest(new Request(`${ORIGIN}/api/capabilities`))).json()) as { id: string; available: boolean }[];
    return list.find((entry) => entry.id === "fixture.toggle")?.available;
  };

  const set = new Request(`${ORIGIN}/api/capabilities/fixture.switch.set`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ on: false }),
  });
  assert.equal((await perRequest(set)).status, 200);
  assert.equal(await toggle(), true);
  assert.deepEqual(counts, { built: 2, released: 2 });

  assert.equal((await perRequest(new Request(`${ORIGIN}/api/capabilities`, { method: "PUT" }))).status, 405);
  assert.deepEqual(counts, { built: 2, released: 2 });
});

test("with shared services, all requests use the same services", async () => {
  const { counts, layer } = countedFixtureLayer();
  const shared = Http.toWebHandler(fixture, layer, { allowedOrigins: [ORIGIN], base: "/api" });
  await shared(new Request(`${ORIGIN}/api/capabilities`));
  await shared(new Request(`${ORIGIN}/api/capabilities`));
  assert.equal(counts.built, 1);
});

for (const services of ["shared", "per-request"] as const) {
  test(`with ${services} services, a refused request builds no services`, async () => {
    const { counts, layer } = countedFixtureLayer();
    const handler = Http.toWebHandler(fixture, layer, { allowedOrigins: [ORIGIN], base: "/api", maximumBytes: 16, services });
    const post = (headers: HeadersInit, body: string) =>
      handler(new Request(`${ORIGIN}/api/capabilities/fixture.echo`, { method: "POST", headers, body }));

    assert.equal((await handler(new Request(`${ORIGIN}/api/capabilities`, { method: "PUT" }))).status, 405);
    assert.equal((await post({ "Content-Type": "application/json", Origin: "https://evil.example" }, "{}")).status, 403);
    assert.equal((await post({ "Content-Type": "text/plain" }, "{}")).status, 415);
    assert.equal((await post({ "Content-Type": "application/json" }, JSON.stringify({ text: "more than 16 bytes" }))).status, 413);
    assert.deepEqual(counts, { built: 0, released: 0 });
  });

  test(`with ${services} services, the abort of a request cancels its call`, async () => {
    const { app, started, interrupted } = heldApp();
    const handler = Http.toWebHandler(app, Layer.empty, { allowedOrigins: [ORIGIN], services });
    const controller = new AbortController();
    const answer = handler(
      new Request(`${ORIGIN}/capabilities/held.wait`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: controller.signal,
      }),
    );

    await Effect.runPromise(Deferred.await(started));
    controller.abort();
    const response = await answer;
    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { kind: "cancelled", message: "The call was cancelled." });
    assert.equal(Deferred.isDoneUnsafe(interrupted), true);
  });

  test(`with ${services} services, a request that is already aborted does not start its call`, async () => {
    const { app, record } = recordingApp();
    const handler = Http.toWebHandler(app, Layer.empty, { allowedOrigins: [ORIGIN], services });
    const response = await handler(
      new Request(`${ORIGIN}/capabilities/recorded.run`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "{}",
        signal: AbortSignal.abort(),
      }),
    );

    assert.equal(response.status, 409);
    assert.deepEqual(await response.json(), { kind: "cancelled", message: "The call was cancelled." });
    assert.equal(record.ran, false);
  });
}
