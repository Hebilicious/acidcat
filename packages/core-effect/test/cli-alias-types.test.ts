import { test } from "node:test";
import { Effect, Schema } from "effect";

import { App, Capability } from "../src/index.ts";

const power = Capability.make({
  id: "probe.power.set",
  description: "Turn the probe on or off.",
  audience: ["cli"],
  input: Schema.Struct({ on: Schema.Boolean }),
  run: () => Effect.succeed(null),
});

const status = Capability.make({ id: "probe.status", description: "Read the status of the probe.", audience: ["cli"], run: () => Effect.succeed(null) });

test("the fixed input of an alias has some properties of the encoded input, with their types", () => {
  // @ts-expect-error The input of probe.power.set has no property onn.
  const unknownKey = App.alias(power, { onn: true });
  // @ts-expect-error The property on of the input of probe.power.set is a boolean.
  const wrongType = App.alias(power, { on: "yes" });
  // @ts-expect-error probe.status has no input.
  const noInput = App.alias(status, { typo: true });
  void [unknownKey, wrongType, noInput];
});
