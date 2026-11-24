import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import { isJsonObject } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import type { CatalogDocument } from "@acid-cat/spec-ts";
import { Deferred, Effect, Exit, Fiber, Layer, Queue, Schema, Scope, Stream, SubscriptionRef } from "effect";

import { App, Capability, Session } from "../src/index.ts";
import { echo, fixture, fixtureLayer, hidden, holdsLayer, position, refuse, Switch, switchLayer, watchersLayer } from "./fixture.ts";

const withSession = <A, E>(target: string, body: (session: Session.Session) => Effect.Effect<A, E, Switch | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(Session.make(fixture, { target }), body)).pipe(Effect.provide(Layer.fresh(fixtureLayer))),
  );

function capabilityIn(document: CatalogDocument, id: string) {
  const capability = document.capabilities[id];
  assert.ok(capability !== undefined, `The catalog has no capability ${id}.`);
  return capability;
}

test("the application writes a catalog that conforms, with the JSON Schema of each form of input", () => {
  const text = App.render(fixture);
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
  const document = App.document(fixture);
  assert.deepEqual(Object.keys(capabilityIn(document, "fixture.refuse").failures ?? {}), ["Refused"]);
  assert.equal(capabilityIn(document, "fixture.echo").readOnly, true);
  assert.deepEqual(capabilityIn(document, "fixture.note").input, { $ref: "#/$defs/Note", description: "The note." });
  assert.deepEqual(capabilityIn(document, "fixture.toggle").input, { type: "object", properties: {} });
  assert.deepEqual(capabilityIn(document, "fixture.raw").input, { type: "object" });
  const flags = capabilityIn(document, "fixture.flags").input?.properties;
  assert.ok(isJsonObject(flags));
  assert.deepEqual(flags.extra, { type: "object" });
});

test("two different schemas with the same identifier stop the catalog", () => {
  const capability = (id: string, choices: readonly [string, string]) =>
    Capability.make({ id, description: "Use a choice.", audience: ["mcp"], input: Schema.Struct({ choice: Schema.Literals(choices).annotate({ identifier: "Choice" }) }), run: () => Effect.succeed(null) });
  const app = App.make({ targets: { mcp: { surfaces: ["mcp"] } }, capabilities: [capability("probe.first", ["a", "b"]), capability("probe.second", ["c", "d"])] });
  assert.throws(() => App.document(app), /probe\.second: two different schemas have the identifier Choice/);
});

test("an input that is a union of objects is an object schema, and the catalog conforms", () => {
  const ByName = Schema.Struct({ name: Schema.String });
  const ById = Schema.Struct({ id: Schema.Int }).annotate({ identifier: "ById" });
  const app = App.make({
    targets: { mcp: { surfaces: ["mcp"] } },
    capabilities: [
      Capability.make({
        id: "probe.find",
        description: "Find a record by name or by id.",
        audience: ["mcp"],
        input: Schema.Union([ByName, ById]),
        run: () => Effect.succeed(null),
      }),
    ],
  });
  const text = App.render(app);
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
  assert.equal(capabilityIn(App.document(app), "probe.find").input?.type, "object");
});

test("a call gives a value, a failure or a call failure", () =>
  withSession("mcp", (session) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* session.invoke("fixture.echo", { text: "hi" }), { ok: true, value: { text: "hi" } });
      assert.deepEqual(yield* session.invoke("fixture.refuse", {}), { ok: false, error: { _tag: "Refused", reason: "No." } });
      const invalid = yield* session.invoke("fixture.echo", { text: 1 });
      assert.equal("kind" in invalid && invalid.kind, "invalid-input");
      assert.deepEqual(yield* session.invoke("fixture.crash", {}), { kind: "internal", message: "The capability failed." });
    }),
  ));

test("a run that throws before it gives its Effect is the call failure internal, through each typed call", async () => {
  const throws = Capability.make({
    id: "probe.throws",
    description: "Throw before the Effect starts.",
    audience: ["app"],
    input: Schema.Struct({}),
    run: (): Effect.Effect<null> => {
      throw new Error("The work does not start.");
    },
  });
  const app = App.make({ targets: { app: { surfaces: ["typescript"] } }, capabilities: [throws] });
  const internal = { kind: "internal", message: "The capability failed." };
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        assert.deepEqual(yield* session.outcome(throws, {}), internal);
        const called = yield* Effect.flip(session.call(throws, {}));
        assert.equal("kind" in called && called.kind, "internal");
      }),
    ),
  );
});

test("a capability outside the target is the same as an unknown id", () =>
  withSession("mcp", (session) =>
    Effect.gen(function* () {
      const hidden = yield* session.invoke("fixture.hidden", {});
      const missing = yield* session.invoke("fixture.missing", {});
      assert.equal("kind" in hidden && hidden.kind, "unknown-capability");
      assert.equal("kind" in missing && missing.kind, "unknown-capability");
      assert.ok(!("fixture.hidden" in session.catalog.capabilities));
    }),
  ));

test("a call is decided on the availability at the moment that it comes in", () =>
  withSession("mcp", (session) =>
    Effect.gen(function* () {
      const switchRef = yield* Switch;
      yield* SubscriptionRef.set(switchRef, position(false));
      assert.deepEqual(yield* session.availability("fixture.toggle"), { available: false, reason: "The switch is off." });
      assert.deepEqual(yield* session.invoke("fixture.toggle", {}), { kind: "unavailable", message: "The switch is off." });
      yield* SubscriptionRef.set(switchRef, position(true));
      assert.deepEqual(yield* session.invoke("fixture.toggle", {}), { ok: true, value: null });
    }),
  ));

test("changes announce each change after they start, and follow the availability only while they run", () =>
  withSession("mcp", (session) =>
    Effect.gen(function* () {
      const switchRef = yield* Switch;
      assert.equal(switchRef.pubsub.subscribers.size, 0);

      const announced = yield* Queue.unbounded<Availability>();
      const follower = yield* session.changes.pipe(
        Stream.runForEach(() => Effect.flatMap(session.availability("fixture.toggle"), (value) => Queue.offer(announced, value))),
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* SubscriptionRef.set(switchRef, position(false));
      assert.deepEqual(yield* Queue.take(announced), position(false));
      assert.equal(switchRef.pubsub.subscribers.size, 1);

      yield* SubscriptionRef.set(switchRef, position(false));
      yield* SubscriptionRef.set(switchRef, position(true));
      assert.deepEqual(yield* Queue.take(announced), position(true));
      assert.equal(yield* Queue.size(announced), 0);

      yield* Fiber.interrupt(follower);
      assert.equal(switchRef.pubsub.subscribers.size, 0);
    }),
  ));

test("closing a session cancels its calls, and later calls fail as cancelled", async () => {
  const holding = Effect.runSync(Deferred.make<void>());
  const marker = { write: () => Deferred.succeed(holding, undefined), remove: () => Effect.void };
  const scope = await Effect.runPromise(Scope.make());
  const session = await Effect.runPromise(
    Session.make(fixture, { target: "mcp" }).pipe(Scope.provide(scope), Effect.provide(Layer.fresh(Layer.mergeAll(switchLayer, holdsLayer(marker), watchersLayer())))),
  );
  const held = Effect.runPromise(session.invoke("fixture.hold", { key: "pending", marker: "holding" }));
  await Effect.runPromise(Deferred.await(holding));
  await Effect.runPromise(Scope.close(scope, Exit.void));
  const outcome = await held;
  assert.ok("kind" in outcome);
  assert.equal(outcome.kind, "cancelled");
  const later = await Effect.runPromise(session.invoke("fixture.echo", { text: "x" }));
  assert.ok("kind" in later);
  assert.equal(later.kind, "cancelled");
});

const callFailureKind = (error: unknown) => {
  assert.ok(error instanceof Session.CallFailed);
  return error.kind;
};

test("call decodes the input with the schema of the capability, execute puts failures in the error channel, and both call only the capability object that the session serves", () =>
  withSession("app", (session) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* Effect.flip(session.execute(refuse, {})), { _tag: "Refused", reason: "No." });
      assert.equal(yield* session.execute(hidden, {}), null);
      const value: { readonly text: string } = yield* session.call(echo, { text: "hi" });
      assert.deepEqual(value, { text: "hi" });
      assert.deepEqual(yield* Effect.flip(session.call(refuse, {})), { _tag: "Refused", reason: "No." });
      assert.equal(callFailureKind(yield* Effect.flip(session.call(echo, { text: 1 }))), "invalid-input");

      const copy = Capability.make({
        id: echo.id,
        description: echo.description,
        audience: echo.audience,
        input: Schema.Struct({ text: Schema.String }),
        output: Schema.Struct({ text: Schema.String }),
        run: (input) => Effect.succeed(input),
      });
      assert.equal(callFailureKind(yield* Effect.flip(session.call(copy, { text: "hi" }))), "unknown-capability");
      assert.equal(callFailureKind(yield* Effect.flip(session.execute(copy, { text: "hi" }))), "unknown-capability");
      const outcome = yield* session.outcome(copy, { text: "hi" });
      assert.ok("kind" in outcome);
      assert.equal(outcome.kind, "unknown-capability");
    }),
  ));
