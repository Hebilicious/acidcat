/**
 * A call runs its program in the same step as its admission: no microtask and no turn of another fiber comes between
 * them, so a program that reads the state of its owner sees the state that admitted the call.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Context, Effect, Layer, Schema, Stream } from "effect";

import { AVAILABLE } from "@acid-cat/spec-ts";

import { App, Capability, Group, Session } from "../src/index.ts";

/**
 * An owner that is open when a call is admitted, and closes on the next microtask after the session reads its
 * availability. A program that runs in the step of its admission sees it open.
 */
function owner() {
  const state = { open: true };
  const available = AVAILABLE;
  const current: Capability.Current<typeof AVAILABLE> = {
    get: Effect.sync(() => {
      state.open = true;
      queueMicrotask(() => (state.open = false));
      return available;
    }),
    changes: Stream.make(available),
  };
  const run = () => (state.open ? Effect.succeed("ran") : Effect.fail("refused" as const));
  return { availability: Effect.succeed(current), run };
}

const metadata = { description: "Act while the owner is open.", audience: ["app"], output: Schema.String, failures: [Schema.Literal("refused")] };

/** Each way to call a capability, with what the call gave. */
async function calls(app: App.App<never>, capability: Capability.Any, layer: Layer.Layer<never> = Layer.empty) {
  return Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        const invoked = yield* session.invoke(capability.id, {});
        const executed = yield* session.execute(capability as never, {} as never).pipe(Effect.result);
        return { invoked, executed: executed._tag === "Success" ? executed.success : executed.failure };
      }),
    ).pipe(Effect.provide(layer)),
  );
}

const targets = { app: { bindings: ["typescript"] } };

test("a capability runs in the step of its admission", async () => {
  const { availability, run } = owner();
  const capability = Capability.make({ id: "owner.act", ...metadata, availability, run });
  assert.deepEqual(await calls(App.make({ targets, capabilities: [capability] }), capability), { invoked: { ok: true, value: "ran" }, executed: "ran" });
});

test("a lazy capability that has loaded runs in the step of its admission", async () => {
  const { availability, run } = owner();
  const lazy = Capability.lazy({ id: "owner.act", description: metadata.description, audience: metadata.audience, availability }, async () =>
    Capability.make({ id: "owner.act", ...metadata, run }),
  );
  const app = App.make({ targets, capabilities: [lazy] });
  await Effect.runPromise(App.load(app));
  assert.deepEqual(await calls(app, lazy), { invoked: { ok: true, value: "ran" }, executed: "ran" });
});

class Owner extends Context.Service<Owner, { readonly open: () => boolean }>()("test/Owner") {}
class Owning extends Context.Service<Owning, Group.Group<Owner>>()("test/Owning") {}

test("a capability of a group that runs runs in the step of its admission", async () => {
  const { availability, run } = owner();
  const capability = Group.capability(Owning, { id: "owner.act", ...metadata, availability, run: () => Owner.use(() => run()) });
  const layer = Layer.effect(Owning, Group.make(Layer.succeed(Owner, { open: () => true })));
  const app = App.make({ targets, capabilities: [capability] });
  const started = Layer.effectDiscard(Effect.flatMap(Owning, (group) => group.start)).pipe(Layer.provideMerge(layer));
  assert.deepEqual(await calls(app as never, capability, started as never), { invoked: { ok: true, value: "ran" }, executed: "ran" });
});
