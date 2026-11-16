import { test } from "node:test";
import { z } from "zod";

import { cliAlias, defineCapability, ok } from "../src/index.ts";

const power = defineCapability({
  id: "probe.power.set",
  description: "Turn the probe on or off.",
  audience: ["cli"],
  input: z.object({ on: z.boolean() }),
  run: () => ok(null),
});

const status = defineCapability({ id: "probe.status", description: "Read the status of the probe.", audience: ["cli"], run: () => ok(null) });

test("the fixed input of an alias has some properties of the input, with their types", () => {
  // @ts-expect-error The input of probe.power.set has no property onn.
  const unknownKey = cliAlias(power, { onn: true });
  // @ts-expect-error The property on of the input of probe.power.set is a boolean.
  const wrongType = cliAlias(power, { on: "yes" });
  // @ts-expect-error probe.status has no input.
  const noInput = cliAlias(status, { typo: true });
  void [unknownKey, wrongType, noInput];
});
