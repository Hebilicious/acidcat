import assert from "node:assert/strict";
import { test } from "node:test";

import { AVAILABLE, bundle, unavailable } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Effect, Exit, Fiber, Layer, Schema, Scope, Stream, SubscriptionRef } from "effect";

import { aircon } from "../examples/aircon.ts";
import { App, Capability, Handles, Mcp, Session } from "../src/index.ts";
import { fixture, fixtureLayer } from "./fixture.ts";

/** A string schema that counts how many times it is written as JSON Schema. */
function countedString() {
  const renders = { count: 0 };
  const schema = Schema.String.check(
    Schema.makeFilter((value: string) => value.length < 100, {
      toJsonSchema: () => {
        renders.count++;
        return { maxLength: 99 };
      },
    }),
  );
  return { renders, schema };
}

/** An application of `size` capabilities. Each one has its own availability switch, and uses a shared named type. */
function largeApplication(size: number) {
  const { renders, schema } = countedString();
  const Shared = Schema.Struct({ name: schema, amount: Schema.Finite }).annotate({ identifier: "Shared" });
  const switches = Array.from({ length: size }, () => Effect.runSync(SubscriptionRef.make<Availability>(AVAILABLE)));
  const app = App.make({
    targets: { app: { bindings: ["typescript"] }, mcp: { bindings: ["mcp"] } },
    capabilities: switches.map((availability, index) =>
      Capability.make({
        id: `probe.item${index}.run`,
        description: `Probe ${index}.`,
        audience: ["app", "mcp"],
        input: Schema.Struct({ shared: Shared }),
        output: Shared,
        availability: SubscriptionRef.changes(availability),
        run: ({ shared }) => Effect.succeed(shared),
      }),
    ),
  });
  return { app, renders, switches };
}

function toolsList(handler: (request: Request) => Promise<Response>) {
  return handler(
    new Request("https://probe.local/mcp", {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "mcp-method": "tools/list",
        "mcp-protocol-version": "2026-07-28",
      },
      body: JSON.stringify({
        jsonrpc: "2.0",
        id: 1,
        method: "tools/list",
        params: { _meta: { "io.modelcontextprotocol/protocolVersion": "2026-07-28", "io.modelcontextprotocol/clientCapabilities": {} } },
      }),
    }),
  ).then(async (response) => ((await response.json()) as { result: { tools: { name: string }[] } }).result.tools);
}

test("opening a session and its handles writes no JSON Schema", async () => {
  const { app, renders } = largeApplication(99);
  const session = await Handles.open(app, Layer.empty, { target: "app" });
  try {
    assert.equal(session.handles.size, 99);
    assert.equal(renders.count, 0);
  } finally {
    await session.dispose();
  }
});

test("MCP writes the schemas of each tool one time, for all the requests", async () => {
  const { app, renders } = largeApplication(99);
  const handler = Mcp.toWebHandler(app, Layer.empty, { name: "probe", version: "0.0.0", allowedOrigins: [] });
  assert.equal((await toolsList(handler)).length, 99);
  const afterFirst = renders.count;
  assert.ok(afterFirst > 0);
  assert.equal((await toolsList(handler)).length, 99);
  assert.equal(renders.count, afterFirst);
});

test("the schemas of each capability are the bundled schemas of the view", () => {
  for (const [app, target] of [
    [fixture, "app"],
    [fixture, "cli"],
    [aircon, "app"],
    [aircon, "mcp"],
  ] as const) {
    const view = App.view(app, target);
    const types = view.$defs ?? {};
    const capabilities = App.capabilitiesOf(app as App.App<unknown>, target);
    assert.deepEqual(capabilities.map((capability) => capability.id), Object.keys(view.capabilities));
    for (const capability of capabilities) {
      const described = view.capabilities[capability.id]!;
      assert.deepEqual(App.inputJsonSchema(capability), bundle(described.input ?? { type: "object" }, types), capability.id);
      assert.deepEqual(
        App.outputJsonSchema(capability),
        described.output === undefined ? undefined : bundle(described.output, types),
        capability.id,
      );
    }
  }
});

test("a change of availability reaches only the handle of its capability, and reads only that capability", async () => {
  const { app, switches } = largeApplication(40);
  const scope = Effect.runSync(Scope.make());
  try {
    const reads: string[] = [];
    const { handles } = await Effect.runPromise(
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target: "app" });
        const counted: Session.Session = {
          ...session,
          availability: (id) => {
            reads.push(id);
            return session.availability(id);
          },
          availabilityNow: (id) => {
            reads.push(id);
            return session.availabilityNow(id);
          },
        };
        return { handles: yield* Handles.make(app, counted) };
      }).pipe(Scope.provide(scope)),
    );
    const notified = new Map<string, Availability[]>();
    for (const [id, handle] of handles) {
      notified.set(id, []);
      handle.availability.subscribe((value) => notified.get(id)!.push(value));
    }
    const readsAtOpen = reads.length;

    const target = "probe.item7.run";
    const reached = new Promise<void>((resolve) => handles.get(target)!.availability.subscribe(() => resolve()));
    Effect.runSync(SubscriptionRef.set(switches[7]!, unavailable("Off.")));
    await reached;

    assert.deepEqual(handles.get(target)!.availability.getSnapshot(), unavailable("Off."));
    assert.deepEqual(new Set(reads.slice(readsAtOpen)), new Set([target]));
    for (const [id, values] of notified) assert.equal(values.length, id === target ? 1 : 0, id);
  } finally {
    await Effect.runPromise(Scope.close(scope, Exit.void));
  }
});

test("the view is written only when it is read, and it is the view of the target", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const session = yield* Session.make(fixture, { target: "mcp" });
        assert.deepEqual([...session.capabilities.keys()], Object.keys(session.view.capabilities));
        assert.equal(session.view, App.view(fixture, "mcp"));
      }),
    ).pipe(Effect.provide(Layer.fresh(fixtureLayer))),
  ));

test("the availability of a capability gives its current value, then each change", () =>
  Effect.runPromise(
    Effect.scoped(
      Effect.gen(function* () {
        const { app, switches } = largeApplication(2);
        const session = yield* Session.make(app, { target: "app" });
        const values = yield* session.availabilityChanges("probe.item1.run").pipe(
          Stream.take(2),
          Stream.runCollect,
          Effect.forkScoped({ startImmediately: true }),
        );
        yield* SubscriptionRef.set(switches[1]!, unavailable("Off."));
        assert.deepEqual([...(yield* Fiber.join(values))], [AVAILABLE, unavailable("Off.")]);
      }),
    ),
  ));
