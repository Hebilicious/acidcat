/**
 * Snapshots of the application on handles (spec/bindings/typescript.md#handles). `moon run core-effect:typecheck` checks
 * the types in this file: each `@ts-expect-error` marks a use of a type that the snapshot does not have.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Context, Effect, Layer, Schema } from "effect";

import { App, Capability, Handles } from "../src/index.ts";

interface Workbench {
  readonly items: { readonly name: string; readonly count: number }[];
}

/** An owner that holds a large typed value, as code without Effect reads it. */
function owner() {
  let current: Workbench = { items: [{ name: "wood", count: 1 }] };
  const listeners = new Set<(value: Workbench) => void>();
  return {
    add(name: string) {
      current = { items: [...current.items, { name, count: 1 }] };
      listeners.forEach((listener) => listener(current));
    },
    snapshot: {
      getSnapshot: () => current,
      subscribe(listener: (value: Workbench) => void) {
        listeners.add(listener);
        return { unsubscribe: () => listeners.delete(listener) };
      },
    } satisfies Capability.Observable<Workbench>,
  };
}

class Owner extends Context.Service<Owner, ReturnType<typeof owner>>()("test/Owner") {}

const inspect = Capability.make({
  id: "probe.workbench.inspect",
  description: "Inspect the workbench.",
  audience: ["app"],
  readOnly: true,
  output: Schema.Struct({ items: Schema.Finite }),
  run: () => Owner.use((service) => Effect.succeed({ items: service.snapshot.getSnapshot().items.length })),
});

const add = Capability.make({
  id: "probe.workbench.add",
  description: "Add an item.",
  audience: ["app"],
  input: Schema.Struct({ name: Schema.String }),
  run: ({ name }) => Owner.use((service) => Effect.sync(() => service.add(name)).pipe(Effect.as(null))),
});

const app = App.make({ targets: { app: { bindings: ["typescript"] } }, capabilities: [inspect, add] });

test("a leaf gives its handle the snapshot of the application, typed, as copies", async () => {
  const workbench = owner();
  const session = await Handles.open(app, Layer.succeed(Owner, workbench), { target: "app" });
  try {
    const handles = Handles.tree(session.handles, {
      workbench: { inspect: Handles.leaf(inspect, { snapshot: workbench.snapshot }), add },
    });
    const snapshot: Capability.Observable<Workbench> = handles.workbench.inspect.snapshot;
    // @ts-expect-error The snapshot is a workbench, not a number.
    const wrong: Capability.Observable<number> = handles.workbench.inspect.snapshot;
    void wrong;

    const first = snapshot.getSnapshot();
    assert.deepEqual(first, { items: [{ name: "wood", count: 1 }] });
    (first.items[0] as { count: number }).count = 99;
    assert.equal(workbench.snapshot.getSnapshot().items[0]!.count, 1);

    const heard: Workbench[] = [];
    snapshot.subscribe((value) => heard.push(value));
    assert.deepEqual(await handles.workbench.add.execute({ name: "iron" }), { ok: true, value: null });
    assert.deepEqual(heard, [{ items: [{ name: "wood", count: 1 }, { name: "iron", count: 1 }] }]);
    assert.notEqual(heard[0], workbench.snapshot.getSnapshot());
    assert.deepEqual(await handles.workbench.inspect.execute({}), { ok: true, value: { items: 2 } });
  } finally {
    await session.dispose();
  }
});

test("treeWith reads the snapshots that need services, and capabilities lists the capabilities of a tree", async () => {
  const workbench = owner();
  const session = await Handles.open(app, Layer.succeed(Owner, workbench), { target: "app" });
  try {
    const capabilities = { workbench: { inspect: Handles.leaf(inspect, { snapshot: Owner.useSync((service) => service.snapshot) }), add } };
    assert.deepEqual(Handles.capabilities(capabilities).map((capability) => capability.id), ["probe.workbench.inspect", "probe.workbench.add"]);
    const handles = await Effect.runPromise(Handles.treeWith(session.handles, capabilities).pipe(Effect.provide(Layer.succeed(Owner, workbench))));
    const snapshot: Capability.Observable<Workbench> = handles.workbench.inspect.snapshot;
    assert.equal(snapshot.getSnapshot().items.length, 1);
    // @ts-expect-error A snapshot that needs a service cannot go to `tree`, which has no services.
    void (() => Handles.tree(session.handles, capabilities));
  } finally {
    await session.dispose();
  }
});
