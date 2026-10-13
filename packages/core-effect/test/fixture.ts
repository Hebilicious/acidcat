/** A test application with one capability for each behavior that the tests examine. */
import { unavailable, AVAILABLE } from "@acid-cat/spec";
import { Context, Effect, Layer, Schema, Stream, SubscriptionRef } from "effect";

import { App, Capability } from "../src/index.ts";

/** A switch that the tests turn on and off, to change the availability of `fixture.toggle`. */
export class Switch extends Context.Service<Switch, SubscriptionRef.SubscriptionRef<boolean>>()("fixture/Switch") {}

export const switchLayer = Layer.effect(Switch, SubscriptionRef.make(true));

const Text = Schema.Struct({ text: Schema.String });
const Refused = Schema.TaggedStruct("Refused", { reason: Schema.String });

const everywhere = ["app", "mcp", "cli", "api"];

export const fixture = App.make({
  title: "Fixture",
  targets: {
    app: { bindings: ["typescript", "webmcp"] },
    mcp: { bindings: ["mcp"] },
    cli: { bindings: ["cli"] },
    api: { bindings: ["http"] },
  },
  capabilities: [
    Capability.make({
      id: "fixture.echo",
      description: "Return the input text.",
      audience: everywhere,
      readOnly: true,
      input: Text,
      output: Text,
      run: (input) => Effect.succeed(input),
    }),
    Capability.make({
      id: "fixture.refuse",
      description: "Always return the failure Refused.",
      audience: everywhere,
      failures: [Refused],
      run: () => Effect.fail(Refused.make({ reason: "No." })),
    }),
    Capability.make({
      id: "fixture.crash",
      description: "Always fail with a defect.",
      audience: everywhere,
      run: () => Effect.die(new Error("secret internal detail")),
    }),
    Capability.make({
      id: "fixture.slow",
      description: "Wait for some milliseconds, then return null.",
      audience: everywhere,
      input: Schema.Struct({ milliseconds: Schema.Finite }),
      run: ({ milliseconds }) => Effect.sleep(milliseconds).pipe(Effect.as(null)),
    }),
    Capability.make({
      id: "fixture.hidden",
      description: "Only the app target can use this capability.",
      audience: ["app"],
      run: () => Effect.succeed(null),
    }),
    Capability.make({
      id: "fixture.toggle",
      description: "Available only while the switch is on.",
      audience: everywhere,
      availability: Stream.unwrap(
        Effect.gen(function* () {
          const ref = yield* Switch;
          return SubscriptionRef.changes(ref).pipe(Stream.map((on) => (on ? AVAILABLE : unavailable("The switch is off."))));
        }),
      ),
      run: () => Effect.succeed(null),
    }),
    Capability.make({
      id: "fixture.switch.set",
      description: "Turn the switch on or off. The switch controls the availability of fixture.toggle.",
      audience: everywhere,
      input: Schema.Struct({ on: Schema.Boolean }),
      run: ({ on }) =>
        Effect.gen(function* () {
          yield* SubscriptionRef.set(yield* Switch, on);
          return null;
        }),
    }),
  ],
});
