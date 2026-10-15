import assert from "node:assert/strict";
import { test } from "node:test";

import { check } from "@acid-cat/cli";
import { Effect, Fiber, Layer, Schema, Scope, Stream, SubscriptionRef } from "effect";

import { App, Capability, Session } from "../src/index.ts";
import { fixture, Switch, switchLayer } from "./fixture.ts";

/** Run a test with a session for a target, and the fixture's services. */
const withSession = <A, E>(target: string, body: (session: Session.Session) => Effect.Effect<A, E, Switch | Scope.Scope>) =>
  Effect.runPromise(
    Effect.scoped(Effect.flatMap(Session.make(fixture, { target }), body)).pipe(Effect.provide(Layer.fresh(switchLayer))),
  );

test("the application writes a catalog that conforms", () => {
  const text = App.render(fixture);
  assert.deepEqual(check(JSON.parse(text), text), { errors: [], warnings: [] });
  const document = App.document(fixture);
  assert.deepEqual(Object.keys(document.capabilities["fixture.refuse"]!.failures ?? {}), ["Refused"]);
  assert.equal(document.capabilities["fixture.echo"]!.readOnly, true);
});

test("an empty struct is an input with no properties, and a record is an input that takes any object", () => {
  const capability = (input: Schema.Codec<any, any>) =>
    Capability.make({ id: "probe.run", description: "Probe.", audience: ["cli"], input, run: () => Effect.succeed(null) });
  const inputOf = (input: Schema.Codec<any, any>) =>
    App.document(App.make({ targets: { cli: { bindings: ["cli"] } }, capabilities: [capability(input)] })).capabilities["probe.run"]!.input;
  assert.deepEqual(inputOf(Schema.Struct({})), { type: "object", properties: {} });
  assert.deepEqual(inputOf(Schema.Record(Schema.String, Schema.Json)), { type: "object" });
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

test("availability follows its stream, and changes are announced", () =>
  withSession("mcp", (session) =>
    Effect.gen(function* () {
      const announced = yield* session.changes.pipe(Stream.take(1), Stream.runDrain, Effect.forkScoped({ startImmediately: true }));
      yield* SubscriptionRef.set(yield* Switch, false);
      yield* Fiber.join(announced);
      assert.deepEqual(yield* session.availability("fixture.toggle"), { available: false, reason: "The switch is off." });
      assert.deepEqual(yield* session.invoke("fixture.toggle", {}), { kind: "unavailable", message: "The switch is off." });
      const reopened = yield* session.availabilityChanges("fixture.toggle").pipe(
        Stream.filter((availability) => availability.available),
        Stream.take(1),
        Stream.runDrain,
        Effect.forkScoped({ startImmediately: true }),
      );
      yield* SubscriptionRef.set(yield* Switch, true);
      yield* Fiber.join(reopened);
      assert.deepEqual(yield* session.invoke("fixture.toggle", {}), { ok: true, value: null });
    }),
  ));

test("closing a session cancels its calls, and later calls fail as cancelled", async () => {
  const scope = await Effect.runPromise(Scope.make());
  const session = await Effect.runPromise(
    Session.make(fixture, { target: "mcp" }).pipe(Scope.provide(scope), Effect.provide(Layer.fresh(switchLayer))),
  );
  const slow = Effect.runPromise(session.invoke("fixture.slow", { milliseconds: 60_000 }));
  await new Promise((resolve) => setTimeout(resolve, 20));
  await Effect.runPromise(Scope.close(scope, { _tag: "Success", value: undefined } as never));
  assert.equal((await slow as { kind?: string }).kind, "cancelled");
  assert.equal(((await Effect.runPromise(session.invoke("fixture.echo", { text: "x" }))) as { kind?: string }).kind, "cancelled");
});

test("execute puts failures and call failures in the error channel", () =>
  withSession("app", (session) =>
    Effect.gen(function* () {
      const [, refuse, , , hidden] = fixture.capabilities;
      assert.deepEqual(yield* Effect.flip(session.execute(refuse!, {})), { _tag: "Refused", reason: "No." });
      const value = yield* session.execute(hidden!, {});
      assert.equal(value, null);
    }),
  ));

test("a value or a failure that does not agree with its schema is an internal call failure", () => {
  const wrong = App.make({
    targets: { app: { bindings: ["typescript"] } },
    capabilities: [
      Capability.make({
        id: "probe.value.give",
        description: "Give a value that is not null.",
        audience: ["app"],
        run: () => Effect.succeed(1 as unknown as null),
      }),
      Capability.make({
        id: "probe.failure.give",
        description: "Give a failure that is not in failures.",
        audience: ["app"],
        failures: [Schema.TaggedStruct("Known", {})],
        run: () => Effect.fail({ _tag: "Unknown" } as unknown as { readonly _tag: "Known" }),
      }),
    ],
  });
  const internal = { kind: "internal", message: "The capability returned a value that does not agree with its schema." };
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(wrong, { target: "app" });
        assert.deepEqual(yield* session.invoke("probe.value.give", {}), internal);
        assert.deepEqual(yield* session.invoke("probe.failure.give", {}), internal);
      }),
    ),
  );
});
