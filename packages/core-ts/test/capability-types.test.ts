/**
 * The types of `defineCapability` and `capabilitiesFor`. `moon run core-ts:typecheck` checks this file: each
 * `@ts-expect-error` marks a program that the types must reject.
 */
import { test } from "node:test";

import { z } from "zod";

import { capabilitiesFor, defineCapability, fail, ok } from "../src/index.ts";

test("defineCapability and capabilitiesFor keep the literal id", () => {
  const find = defineCapability({ id: "probe.find", description: "Find a record.", audience: ["mcp"], run: () => ok(null) });
  const capability = capabilitiesFor<{ readonly store: Map<string, string> }>();
  const save = capability({ id: "probe.save", description: "Save a record.", audience: ["mcp"], run: () => ok(null) });

  const ids: readonly ["probe.find", "probe.save"] = [find.id, save.id];
  // @ts-expect-error The id is "probe.find".
  const other: "probe.load" = find.id;
  void [ids, other];
});

test("run gets the type of its input from the input schema, and its result must agree with the other schemas", () => {
  const Overflow = z.object({ _tag: z.literal("Overflow"), capacity: z.number() });
  const capability = capabilitiesFor<{ readonly capacity: number }>();
  const fill = capability({
    id: "probe.fill",
    description: "Add water.",
    audience: ["mcp"],
    input: z.object({ litres: z.number() }),
    failures: { Overflow },
    run: ({ litres }, { context }) => (litres > context.capacity ? fail({ _tag: "Overflow", capacity: context.capacity }) : ok(null)),
  });
  const empty = capability({
    id: "probe.empty",
    description: "Take no input.",
    audience: ["mcp"],
    run: (input) => {
      const nothing: Record<string, never> = input;
      return ok(nothing === input ? null : null);
    },
  });

  // These declarations are not used. `moon run core-ts:typecheck` checks that each one is an error.
  const wrong = [
    // @ts-expect-error The failure Overflow must have `capacity`.
    capability({ id: "probe.a", description: "x", audience: [], failures: { Overflow }, run: () => fail({ _tag: "Overflow" }) }),
    // @ts-expect-error The only failure is Overflow.
    capability({ id: "probe.b", description: "x", audience: [], failures: { Overflow }, run: () => fail({ _tag: "Empty" }) }),
    // @ts-expect-error With no output schema, the value is `null`.
    capability({ id: "probe.c", description: "x", audience: [], run: () => ok(1) }),
    // @ts-expect-error The value must agree with the output schema.
    capability({ id: "probe.d", description: "x", audience: [], output: z.object({ celsius: z.number() }), run: () => ok({ celsius: "hot" }) }),
    // @ts-expect-error `litres` is a number.
    capability({ id: "probe.e", description: "x", audience: [], input: z.object({ litres: z.number() }), run: ({ litres }) => ok(litres === "one" ? null : null) }),
  ];
  void [fill, empty, wrong];
});
