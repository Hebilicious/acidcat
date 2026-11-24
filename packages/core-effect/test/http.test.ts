import assert from "node:assert/strict";
import { test } from "node:test";

import { Deferred, Effect, Layer, Schema, SubscriptionRef } from "effect";

import { Http } from "../src/index.ts";
import { CatalogShape, decodeBody, Listing } from "./decode.ts";
import { countedFixtureLayer, fixture, fixtureLayer, heldApp, position, recordingApp, Switch } from "./fixture.ts";

const ORIGIN = "https://fixture.example";
const handler = Http.toWebHandler(fixture, Layer.fresh(fixtureLayer), { allowedOrigins: [ORIGIN], base: "/api" });

test("a body that is not JSON gives the failure of an unknown id, or of an unavailable capability, first", async () => {
  const off = Layer.fresh(Layer.mergeAll(fixtureLayer, Layer.effect(Switch, SubscriptionRef.make(position(false)))));
  const handler = Http.toWebHandler(fixture, off, { allowedOrigins: [ORIGIN], base: "/api" });
  const postText = async (id: string, body: string) => {
    const response = await handler(new Request(`${ORIGIN}/api/capabilities/${id}`, { method: "POST", headers: { "Content-Type": "application/json" }, body }));
    return { status: response.status, kind: (await decodeBody(Schema.Struct({ kind: Schema.String }), response)).kind };
  };
  assert.deepEqual(await postText("no.such", "nope"), { status: 404, kind: "unknown-capability" });
  assert.deepEqual(await postText("fixture.hidden", "nope"), { status: 404, kind: "unknown-capability" });
  assert.deepEqual(await postText("fixture.toggle", "nope"), { status: 503, kind: "unavailable" });
  assert.deepEqual(await postText("fixture.echo", "nope"), { status: 422, kind: "invalid-input" });
});

test("a path that is not under base is an unknown route", async () => {
  assert.equal((await handler(new Request(`${ORIGIN}/api/capabilities`))).status, 200);
  for (const path of ["/zzz/capabilities", "/apix/capabilities", "/zzz/catalog", "/zzz/events"]) {
    assert.equal((await handler(new Request(`${ORIGIN}${path}`))).status, 404, path);
  }
  const call = await handler(new Request(`${ORIGIN}/zzz/capabilities/fixture.echo`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }));
  assert.equal(call.status, 404);
});

test("GET /catalog gives the catalog of the target", async () => {
  const catalog = await decodeBody(CatalogShape, await handler(new Request(`${ORIGIN}/api/catalog`)));
  assert.deepEqual(Object.keys(catalog.targets), ["api"]);
});

test("with per-request services, each request that passes the screening has its own services", async () => {
  const { counts, layer } = countedFixtureLayer();
  const perRequest = Http.toWebHandler(fixture, layer, { allowedOrigins: [ORIGIN], base: "/api", services: "per-request" });
  const toggle = async () => {
    const list = await decodeBody(Listing, await perRequest(new Request(`${ORIGIN}/api/capabilities`)));
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

test("with per-request services, the abort of a request cancels its call", async () => {
  const { app, started, interrupted } = heldApp();
  const handler = Http.toWebHandler(app, Layer.empty, { allowedOrigins: [ORIGIN], services: "per-request" });
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
