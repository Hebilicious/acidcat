import assert from "node:assert/strict";
import { test } from "node:test";

import { Layer } from "effect";

import { Http } from "../src/index.ts";
import { fixture, switchLayer } from "./fixture.ts";

const ORIGIN = "https://fixture.example";
const handler = Http.toWebHandler(fixture, Layer.fresh(switchLayer), { allowedOrigins: [ORIGIN], base: "/api" });

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
