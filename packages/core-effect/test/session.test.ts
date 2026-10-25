import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import type { Availability } from "@acid-cat/spec-ts";
import type { CatalogDocument } from "@acid-cat/spec-ts";
import { Effect, Exit, Fiber, Layer, Queue, Schema, Scope, Stream, SubscriptionRef } from "effect";

import { App, Capability, Session } from "../src/index.ts";
import { fixture, fixtureLayer, hidden, position, refuse, Switch } from "./fixture.ts";

/** Run a test with a session for a target, and the fixture's services. */
const withSession = <A, E>(target: string, body: (session: Session.Session) => Effect.Effect<A, E, Switch | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(Session.make(fixture, { target }), body)).pipe(Effect.provide(Layer.fresh(fixtureLayer))),
  );

/** The capability of a catalog with an id. It must exist. */
function capabilityIn(document: CatalogDocument, id: string) {
  const capability = document.capabilities[id];
  assert.ok(capability !== undefined, `The catalog has no capability ${id}.`);
  return capability;
}

test("the application writes a catalog that conforms", () => {
  const text = App.render(fixture);
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
  const document = App.document(fixture);
  assert.deepEqual(Object.keys(capabilityIn(document, "fixture.refuse").failures ?? {}), ["Refused"]);
  assert.equal(capabilityIn(document, "fixture.echo").readOnly, true);
});

test("an empty struct is an input with no properties, and a record is an input that takes any object", () => {
  const capability = (input: Capability.AnySchema) =>
    Capability.make({ id: "probe.run", description: "Probe.", audience: ["cli"], input, run: () => Effect.succeed(null) });
  const inputOf = (input: Capability.AnySchema) =>
    capabilityIn(App.document(App.make({ targets: { cli: { bindings: ["cli"] } }, capabilities: [capability(input)] })), "probe.run").input;
  assert.deepEqual(inputOf(Schema.Struct({})), { type: "object", properties: {} });
  assert.deepEqual(inputOf(Schema.Record(Schema.String, Schema.Json)), { type: "object" });
});

test("an input that is a union of objects is an object schema, and the catalog conforms", () => {
  const ByName = Schema.Struct({ name: Schema.String });
  const ById = Schema.Struct({ id: Schema.Int }).annotate({ identifier: "ById" });
  const app = App.make({
    targets: { mcp: { bindings: ["mcp"] } },
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

test("a capability outside the view is the same as an unknown id", () =>
  withSession("mcp", (session) =>
    Effect.gen(function* () {
      const hidden = yield* session.invoke("fixture.hidden", {});
      const missing = yield* session.invoke("fixture.missing", {});
      assert.equal("kind" in hidden && hidden.kind, "unknown-capability");
      assert.equal("kind" in missing && missing.kind, "unknown-capability");
      assert.ok(!("fixture.hidden" in session.view.capabilities));
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
  const scope = await Effect.runPromise(Scope.make());
  const session = await Effect.runPromise(
    Session.make(fixture, { target: "mcp" }).pipe(Scope.provide(scope), Effect.provide(Layer.fresh(fixtureLayer))),
  );
  const held = Effect.runPromise(session.invoke("fixture.hold", { key: "pending" }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Effect.runPromise(Scope.close(scope, Exit.void));
  const outcome = await held;
  assert.ok("kind" in outcome);
  assert.equal(outcome.kind, "cancelled");
  const later = await Effect.runPromise(session.invoke("fixture.echo", { text: "x" }));
  assert.ok("kind" in later);
  assert.equal(later.kind, "cancelled");
});

test("execute puts failures and call failures in the error channel", () =>
  withSession("app", (session) =>
    Effect.gen(function* () {
      assert.deepEqual(yield* Effect.flip(session.execute(refuse, {})), { _tag: "Refused", reason: "No." });
      const value = yield* session.execute(hidden, {});
      assert.equal(value, null);
    }),
  ));
