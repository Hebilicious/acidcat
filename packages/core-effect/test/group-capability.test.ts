/**
 * Capabilities that run inside a group. `moon run core-effect:typecheck` checks the types in this file.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Context, Deferred, Effect, Exit, Fiber, Layer, Schema, Scope } from "effect";

import { App, Group, Session } from "../src/index.ts";

class Planner extends Context.Service<
  Planner,
  { readonly plan: (stops: number) => string; readonly running: Deferred.Deferred<void> }
>()("test/Planner") {}
class Planning extends Context.Service<Planning, Group.Group<Planner>>()("test/Planning") {}

function planning() {
  const counts = { started: 0 };
  const layer = Layer.effect(
    Planning,
    Group.make(
      Layer.effect(
        Planner,
        Effect.gen(function* () {
          counts.started++;
          return { plan: (stops: number) => `a plan of ${stops} stops`, running: yield* Deferred.make<void>() };
        }),
      ),
    ),
  );
  return { counts, layer };
}

const generate = Group.capability(Planning, {
  id: "plan.generate",
  description: "Make a plan.",
  audience: ["app"],
  input: Schema.Struct({ stops: Schema.Int }),
  output: Schema.String,
  run: ({ stops }) => Planner.use((planner) => Effect.succeed(planner.plan(stops))),
});

const wait = Group.capability(Planning, {
  id: "plan.wait",
  description: "Wait with the planner until the call is cancelled.",
  audience: ["app"],
  run: () => Planner.use((planner) => Deferred.succeed(planner.running, undefined).pipe(Effect.andThen(Effect.never))),
});

const app = App.make({ targets: { app: { bindings: ["typescript"] } }, capabilities: [generate, wait] });

test("a capability of a group runs inside the group, which its first call starts, and needs only the group", async () => {
  type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;
  const onlyTheGroup: Equals<App.App<Planning>, typeof app> = true;
  void onlyTheGroup;

  const { counts, layer } = planning();
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        assert.equal(counts.started, 0);
        assert.deepEqual(yield* session.invoke("plan.generate", { stops: 3 }), { ok: true, value: "a plan of 3 stops" });
        assert.deepEqual(yield* session.invoke("plan.generate", { stops: 4 }), { ok: true, value: "a plan of 4 stops" });
        assert.equal(counts.started, 1);
      }),
    ).pipe(Effect.provide(layer)),
  );
});

test("closing the group cancels the calls of its capabilities", async () => {
  const { layer } = planning();
  const groupScope = Effect.runSync(Scope.make());
  const services = await Effect.runPromise(Layer.buildWithScope(layer, groupScope));
  await Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        const group = yield* Planning;
        const call = yield* Effect.forkScoped(session.invoke("plan.wait", {}), { startImmediately: true });
        yield* group.start;
        yield* Deferred.await(group.peek((started) => Context.get(started, Planner))!.running);
        yield* Scope.close(groupScope, Exit.void);
        assert.deepEqual(yield* Fiber.join(call), { kind: "cancelled", message: "The call was cancelled." });
      }),
    ).pipe(Effect.provideContext(services)),
  );
});
