/**
 * The services of each request: the HTTP and MCP bindings build them from the head of the request, a capability reads
 * the caller from them and the target from its session, and a refusal answers the request instead.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Context, Effect, Layer, Schema, Stream } from "effect";

import { App, Capability, Event, Http, Mcp, Remote, Session } from "../src/index.ts";
import { decodeBody } from "./decode.ts";
import { json, mcpRequest, ORIGIN } from "./mcp-client.ts";

/** Who calls. The layer builds it for each request, from the token of the request. */
class Caller extends Context.Service<Caller, { readonly name: string }>()("request-services/Caller") {}

const Who = Schema.Struct({ caller: Schema.String, target: Schema.String });

const who = Capability.make({
  id: "who.get",
  description: "Give the caller and the target of the call.",
  audience: ["api", "mcp"],
  readOnly: true,
  output: Who,
  run: () => Effect.all({ caller: Caller.use((caller) => Effect.succeed(caller.name)), target: Session.Target }),
});

const targeted = Event.make({
  id: "who.targeted",
  description: "Give one occurrence with the target of the subscription, then end.",
  audience: ["app", "api"],
  payload: Schema.Struct({ target: Schema.String }),
  subscribe: () => Stream.fromEffect(Effect.map(Session.Target, (target) => ({ data: { target } }))),
});

const app = App.make({
  title: "Who",
  description: "Tell the caller and the target of each call.",
  targets: { app: { bindings: ["typescript"] }, api: { bindings: ["http"] }, mcp: { bindings: ["mcp"] } },
  capabilities: [who],
  events: [targeted],
});

/**
 * Build the caller from `Authorization: Bearer <name>`, or refuse the request with 401. `counts` tells how many callers
 * were built and released.
 */
function callerLayer() {
  const counts = { built: 0, released: 0 };
  const layer = Layer.effect(
    Caller,
    Effect.gen(function* () {
      const request = yield* Remote.IncomingRequest;
      const name = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
      if (name === undefined) return yield* Remote.refuse(401, "Give a token.", { "WWW-Authenticate": "Bearer" });
      return yield* Effect.acquireRelease(
        Effect.sync(() => {
          counts.built += 1;
          return { name };
        }),
        () => Effect.sync(() => (counts.released += 1)),
      );
    }),
  );
  return { counts, layer };
}

const Refused = Schema.Struct({ message: Schema.String });

test("through HTTP, the capability gets the caller of the request and the target", async () => {
  const { counts, layer } = callerLayer();
  const handler = Http.toWebHandler(app, layer, { allowedOrigins: [ORIGIN], services: "per-request" });
  const post = (headers: Record<string, string>) =>
    handler(new Request(`${ORIGIN}/capabilities/who.get`, { method: "POST", headers: { "Content-Type": "application/json", ...headers }, body: "{}" }));

  const answer = await post({ Authorization: "Bearer dashboard" });
  assert.equal(answer.status, 200);
  assert.deepEqual(await answer.json(), { ok: true, value: { caller: "dashboard", target: "api" } });
  assert.deepEqual(counts, { built: 1, released: 1 }, "the services are released after the answer");

  const refused = await post({});
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get("WWW-Authenticate"), "Bearer");
  assert.equal(refused.headers.get("Content-Type"), "application/json");
  assert.deepEqual(await decodeBody(Refused, refused), { message: "Give a token." });
  assert.deepEqual(counts, { built: 1, released: 1 });
});

test("through MCP, the capability gets the caller of the request and the target", async () => {
  const { counts, layer } = callerLayer();
  const handler = Mcp.toWebHandler(app, layer, { name: "who", version: "0.0.0", allowedOrigins: [ORIGIN], services: "per-request" });
  const call = (headers: Record<string, string>) => handler(mcpRequest("tools/call", { name: "who.get", arguments: {} }, { headers }));

  const answer = await call({ Authorization: "Bearer bank-agent" });
  assert.equal(answer.status, 200);
  const result = Schema.decodeUnknownSync(Schema.Struct({ structuredContent: Who }))((await json(answer)).result);
  assert.deepEqual(result.structuredContent, { caller: "bank-agent", target: "mcp" });
  assert.deepEqual(counts, { built: 1, released: 1 }, "the services are released after the answer");

  const refused = await call({});
  assert.equal(refused.status, 401);
  assert.equal(refused.headers.get("WWW-Authenticate"), "Bearer");
  assert.deepEqual(await decodeBody(Refused, refused), { message: "Give a token." });
  assert.deepEqual(counts, { built: 1, released: 1 });
  await handler.dispose();
});

test("the provider of an event reads the target of its session", async () => {
  const data = await Effect.runPromise(
    Effect.gen(function* () {
      const session = yield* Session.make(app, { target: "app" });
      const subscription = yield* session.subscribe("who.targeted", {});
      return Array.from(yield* Stream.runCollect(subscription), (occurrence) => occurrence.data);
    }).pipe(Effect.scoped, Effect.provideService(Caller, { name: "nobody" })),
  );
  assert.deepEqual(data, [{ target: "app" }]);

  const { layer } = callerLayer();
  const handler = Http.toWebHandler(app, layer, { allowedOrigins: [ORIGIN], services: "per-request" });
  const stream = await handler(
    new Request(`${ORIGIN}/events/who.targeted`, { method: "POST", headers: { "Content-Type": "application/json", Authorization: "Bearer reader" }, body: "{}" }),
  );
  assert.equal(stream.status, 200);
  assert.match(await stream.text(), /"target":"api"/);
});

test("only per-request services can read the request", () => {
  const shared = () =>
    // @ts-expect-error A layer that reads the request needs `services: "per-request"`.
    Http.toWebHandler(app, callerLayer().layer, { allowedOrigins: [ORIGIN] });
  assert.equal(typeof shared, "function");
});

test("a refusal needs a status from 400 to 599", () => {
  assert.throws(() => Remote.refuse(200, "Not a refusal."), RangeError);
  assert.throws(() => Remote.refuse(600, "Not a status."), RangeError);
  assert.doesNotThrow(() => Remote.refuse(403, "No."));
});
