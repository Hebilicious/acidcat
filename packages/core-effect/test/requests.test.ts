import assert from "node:assert/strict";
import { test } from "node:test";

import { Context, Deferred, Effect, Layer } from "effect";

import { App, Capability, Http, Mcp } from "../src/index.ts";
import { countedFixtureLayer, fixture, holdsLayer, Switch } from "./fixture.ts";

const ORIGIN = "https://probe.example";

/** The points of a call that the tests wait for: the call started, and the call was interrupted. */
class Blocker extends Context.Service<Blocker, { readonly started: Deferred.Deferred<void>; readonly interrupted: Deferred.Deferred<void> }>()(
  "test/Blocker",
) {}

const blocking = App.make({
  description: "A capability that waits until it is cancelled.",
  targets: { mcp: { bindings: ["mcp"] }, api: { bindings: ["http"] } },
  capabilities: [
    Capability.make({
      id: "probe.block",
      description: "Wait until the call is cancelled.",
      audience: ["mcp", "api"],
      run: () =>
        Blocker.use(({ started, interrupted }) =>
          Deferred.succeed(started, undefined).pipe(
            Effect.andThen(Effect.never),
            Effect.onInterrupt(() => Deferred.succeed(interrupted, undefined)),
          ),
        ),
    }),
  ],
});

function blocker() {
  const started = Effect.runSync(Deferred.make<void>());
  const interrupted = Effect.runSync(Deferred.make<void>());
  return { started, interrupted, layer: Layer.succeed(Blocker, { started, interrupted }) };
}

function mcpCall(name: string, signal?: AbortSignal) {
  return new Request(`${ORIGIN}/mcp`, {
    method: "POST",
    headers: {
      Accept: "application/json, text/event-stream",
      "Content-Type": "application/json",
      "mcp-method": "tools/call",
      "mcp-name": name,
      "mcp-protocol-version": "2026-07-28",
    },
    body: JSON.stringify({
      jsonrpc: "2.0",
      id: 1,
      method: "tools/call",
      params: {
        name,
        arguments: {},
        _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} },
      },
    }),
    ...(signal === undefined ? {} : { signal }),
  });
}

const httpCall = (id: string, signal?: AbortSignal) =>
  new Request(`${ORIGIN}/api/capabilities/${id}`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: "{}",
    ...(signal === undefined ? {} : { signal }),
  });

/** Requests that each remote binding rejects before it opens a session. */
const rejected = (path: string) => [
  new Request(`${ORIGIN}${path}`, { method: "PUT" }),
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "application/json", Origin: "https://evil.example" }, body: "{}" }),
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "text/plain" }, body: "{}" }),
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: " ".repeat(1_048_577) }),
  new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{" }),
];

test("Mcp.handle with services builds nothing for a request that it rejects", async () => {
  const { counts, layer } = countedFixtureLayer();
  const options = { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN] };
  for (const request of rejected("/mcp")) {
    const response = await Effect.runPromise(Mcp.handle(fixture, request, options, layer));
    assert.ok(response.status >= 400, `${request.method} must be rejected`);
  }
  assert.deepEqual(counts, { built: 0, released: 0 });
  assert.equal((await Effect.runPromise(Mcp.handle(fixture, mcpCall("fixture.echo"), options, layer))).status, 200);
  assert.deepEqual(counts, { built: 1, released: 1 });
});

test("Http.handle with services builds nothing for a request that it rejects or that has no route", async () => {
  const { counts, layer } = countedFixtureLayer();
  const options = { allowedOrigins: [ORIGIN], base: "/api" };
  const requests = [
    ...rejected("/api/capabilities/fixture.echo"),
    new Request(`${ORIGIN}/api/nothing`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" }),
  ];
  for (const request of requests) {
    const response = await Effect.runPromise(Http.handle(fixture, request, options, layer));
    assert.ok(response.status >= 400, `${request.method} ${request.url} must be rejected`);
  }
  assert.deepEqual(counts, { built: 0, released: 0 });
});

for (const services of ["shared", "per-request"] as const) {
  test(`MCP with ${services} services: the signal of the request cancels the call, and the request rejects with its reason`, async () => {
    const { started, interrupted, layer } = blocker();
    const handler = Mcp.toWebHandler(blocking, layer, { name: "probe", version: "0.0.0", allowedOrigins: [ORIGIN], services });
    const controller = new AbortController();
    const reason = new Error("The client went away.");
    const answered = handler(mcpCall("probe.block", controller.signal));
    await Effect.runPromise(Deferred.await(started));
    controller.abort(reason);
    await assert.rejects(answered, (error) => error === reason);
    await Effect.runPromise(Deferred.await(interrupted));
  });

  test(`HTTP with ${services} services: the signal of the request cancels the call, and the request rejects with its reason`, async () => {
    const { started, interrupted, layer } = blocker();
    const handler = Http.toWebHandler(blocking, layer, { allowedOrigins: [ORIGIN], base: "/api", services });
    const controller = new AbortController();
    const reason = new Error("The client went away.");
    const answered = handler(httpCall("probe.block", controller.signal));
    await Effect.runPromise(Deferred.await(started));
    controller.abort(reason);
    await assert.rejects(answered, (error) => error === reason);
    await Effect.runPromise(Deferred.await(interrupted));
  });
}

test("shared handlers build nothing for a request that they reject, and reject it when the services cannot be built", async () => {
  const { counts, layer } = countedFixtureLayer();
  const mcp = Mcp.toWebHandler(fixture, layer, { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN] });
  const http = Http.toWebHandler(fixture, layer, { allowedOrigins: [ORIGIN], base: "/api" });
  for (const request of [...rejected("/mcp")]) assert.ok((await mcp(request)).status >= 400);
  for (const request of [...rejected("/api/capabilities/fixture.echo")]) assert.ok((await http(request)).status >= 400);
  assert.deepEqual(counts, { built: 0, released: 0 });

  const broken = Layer.merge(Layer.effect(Switch, Effect.die(new Error("The services cannot be built."))), holdsLayer());
  const brokenMcp = Mcp.toWebHandler(fixture, broken, { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN] });
  const brokenHttp = Http.toWebHandler(fixture, broken, { allowedOrigins: [ORIGIN], base: "/api" });
  assert.equal((await brokenMcp(new Request(`${ORIGIN}/mcp`, { method: "GET" }))).status, 405);
  assert.equal((await brokenHttp(new Request(`${ORIGIN}/api/capabilities`, { method: "PUT" }))).status, 405);
});

/** A POST whose body sends one byte, then never ends. */
function stalled(path: string, signal: AbortSignal) {
  const body = new ReadableStream<Uint8Array>({ start: (controller) => controller.enqueue(new TextEncoder().encode("{")) });
  return new Request(`${ORIGIN}${path}`, { method: "POST", headers: { "Content-Type": "application/json" }, body, signal, duplex: "half" } as RequestInit);
}

for (const services of ["shared", "per-request"] as const) {
  test(`with ${services} services, an aborted request whose body never ends rejects with the reason of its signal`, async () => {
    const { counts, layer } = countedFixtureLayer();
    const handlers = {
      "/mcp": Mcp.toWebHandler(fixture, layer, { name: "fixture", version: "0.0.0", allowedOrigins: [ORIGIN], services }),
      "/api/capabilities/fixture.echo": Http.toWebHandler(fixture, layer, { allowedOrigins: [ORIGIN], base: "/api", services }),
    };
    for (const [path, handler] of Object.entries(handlers)) {
      const controller = new AbortController();
      const reason = new Error(`The client of ${path} went away.`);
      const answered = handler(stalled(path, controller.signal));
      controller.abort(reason);
      await assert.rejects(answered, (error) => error === reason);
    }
    assert.deepEqual(counts, { built: 0, released: 0 });
  });
}
