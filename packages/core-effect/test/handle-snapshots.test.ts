/**
 * Snapshots of the application on handles (spec/bindings/typescript.md#handles). `moon run core-effect:typecheck` checks
 * the types in this file: each `@ts-expect-error` marks a use of a type that the snapshot does not have.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { Context, Effect, Layer, Schema, Stream } from "effect";

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

test("a capability with state, or outside the view, cannot have the snapshot of a leaf", async () => {
  const stateful = Capability.make({
    id: "probe.status.get",
    description: "Read the status.",
    audience: ["app"],
    state: { schema: Schema.Finite, changes: Stream.make(1) },
    run: () => Effect.succeed(null),
  });
  assert.throws(() => Handles.leaf(stateful, { snapshot: owner().snapshot }), /has state/);

  const hidden = Capability.make({ id: "probe.hidden.read", description: "Hidden.", audience: ["cli"], run: () => Effect.succeed(null) });
  const session = await Handles.open(app, Layer.succeed(Owner, owner()), { target: "app" });
  try {
    assert.throws(() => Handles.tree(session.handles, { hidden: Handles.leaf(hidden, { snapshot: owner().snapshot }) }), /outside the view/);
  } finally {
    await session.dispose();
  }
});

test("a snapshot is data, and an Effect that waits gives it through treeWith only", async () => {
  const withFunction = { getSnapshot: () => ({ count: 1, read: () => 1 }), subscribe: () => ({ unsubscribe() {} }) };
  // @ts-expect-error A function is not data that a copy keeps.
  void (() => Handles.leaf(inspect, { snapshot: withFunction }));

  const workbench = owner();
  const waiting = Handles.leaf(inspect, { snapshot: Effect.sleep(1).pipe(Effect.as(workbench.snapshot)) });
  const session = await Handles.open(app, Layer.succeed(Owner, workbench), { target: "app" });
  try {
    // @ts-expect-error A snapshot that is an Effect goes to treeWith, which can wait for it.
    void (() => Handles.tree(session.handles, { inspect: waiting }));
    const handles = await Effect.runPromise(Handles.treeWith(session.handles, { inspect: waiting }));
    assert.equal(handles.inspect.snapshot.getSnapshot().items.length, 1);
  } finally {
    await session.dispose();
  }
});

test("a generic helper can make a leaf, and its callers get the check of the data", async () => {
  /** A helper of an application, generic over the snapshot, that makes a leaf with no cast. */
  const withSnapshot = <C extends Capability.Any, State>(
    capability: C,
    options: { readonly snapshot: Capability.Observable<State> } & Handles.OnlyData<State>,
  ) => Handles.leaf(capability, options);

  const workbench = owner();
  const typed = withSnapshot(inspect, { snapshot: workbench.snapshot });
  const session = await Handles.open(app, Layer.succeed(Owner, workbench), { target: "app" });
  try {
    const snapshot: Capability.Observable<Workbench> = Handles.tree(session.handles, { inspect: typed }).inspect.snapshot;
    assert.equal(snapshot.getSnapshot().items.length, 1);
  } finally {
    await session.dispose();
  }
  const withFunction = { getSnapshot: () => ({ read: () => 1 }), subscribe: () => ({ unsubscribe() {} }) };
  // @ts-expect-error A caller of the helper still gets the check: a function is not data.
  void (() => withSnapshot(inspect, { snapshot: withFunction }));
});
