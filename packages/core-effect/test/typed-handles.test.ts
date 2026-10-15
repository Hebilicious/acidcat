/**
 * Typed handles. `moon run core-effect:typecheck` checks the types in this file: each `@ts-expect-error` marks a call
 * with a type that the capability does not accept.
 */
import assert from "node:assert/strict";
import { test } from "node:test";

import { CallFailureError } from "@acid-cat/spec-ts";
import type { Result } from "@acid-cat/spec-ts";
import { Effect, Layer, Schema } from "effect";

import { App, Capability, Handles } from "../src/index.ts";

const Refused = Schema.TaggedStruct("Refused", { reason: Schema.String });

const echo = Capability.make({
  id: "probe.echo",
  description: "Return the input text.",
  audience: ["app"],
  input: Schema.Struct({ text: Schema.String }),
  output: Schema.Struct({ text: Schema.String }),
  run: (input) => Effect.succeed(input),
});

const refuse = Capability.make({
  id: "probe.refuse",
  description: "Refuse.",
  audience: ["app"],
  failures: [Refused],
  run: () => Effect.fail(Refused.make({ reason: "No." })),
});

const hidden = Capability.make({
  id: "probe.hidden",
  description: "Only for the cli target.",
  audience: ["cli"],
  run: () => Effect.succeed(null),
});

const app = App.make({
  targets: { app: { bindings: ["typescript"] }, cli: { bindings: ["cli"] } },
  capabilities: [echo, refuse, hidden],
});

test("a tree of handles has the shape and the types of the tree of capabilities", async () => {
  const session = await Handles.open(app, Layer.empty, { target: "app" });
  try {
    const handles = Handles.tree(session.handles, { probe: { echo, refuse }, hidden });

    const echoed: Result<{ readonly text: string }, never> = await handles.probe.echo.execute({ text: "hi" });
    assert.deepEqual(echoed, { ok: true, value: { text: "hi" } });
    // @ts-expect-error The input of probe.echo has a text.
    void handles.probe.echo.execute({ count: 1 }).catch(() => undefined);

    const refused: Result<null, { readonly _tag: "Refused"; readonly reason: string }> = await handles.probe.refuse.execute({});
    assert.deepEqual(refused, { ok: false, error: { _tag: "Refused", reason: "No." } });

    assert.equal(Handles.get(session.handles, echo), session.handles.get("probe.echo"));
  } finally {
    await session.dispose();
  }
});

test("a capability outside the view has a handle that is always unavailable", async () => {
  const session = await Handles.open(app, Layer.empty, { target: "app" });
  try {
    const handle = Handles.get(session.handles, hidden);
    assert.equal(handle.availability.getSnapshot().available, false);
    const error = await handle.execute({}).then(
      () => assert.fail("the call must reject"),
      (caught: unknown) => caught,
    );
    assert.ok(error instanceof CallFailureError);
    assert.equal(error.kind, "unknown-capability");
  } finally {
    await session.dispose();
  }
});
