/**
 * Capabilities that lazy capabilities load. Each evaluation of this module counts for its own URL, so a test that imports
 * it with a URL of its own (`?case=`) sees only its own loads.
 */
import { Effect, Schema, Stream } from "effect";

import { Capability } from "../src/index.ts";

const evaluations = ((globalThis as { lazyProbeEvaluations?: Record<string, number> }).lazyProbeEvaluations ??= {});
evaluations[import.meta.url] = (evaluations[import.meta.url] ?? 0) + 1;

const Plan = Schema.Struct({ stops: Schema.Int, label: Schema.String }).annotate({ identifier: "Plan" });
const TooFar = Schema.TaggedStruct("TooFar", { stops: Schema.Int });

export const generate = Capability.make({
  id: "plan.generate",
  description: "Make a plan with some stops.",
  audience: ["app", "mcp", "cli", "api"],
  readOnly: true,
  input: Schema.Struct({ stops: Schema.Int }),
  output: Plan,
  failures: [TooFar],
  run: ({ stops }) => (stops > 10 ? Effect.fail(TooFar.make({ stops })) : Effect.succeed({ stops, label: `${stops} stops` })),
});

export const withState = Capability.make({
  id: "plan.status",
  description: "The status of the planner.",
  audience: ["app"],
  state: { schema: Schema.String, changes: Stream.make("idle") },
  run: () => Effect.succeed(null),
});

export const list = Capability.make({
  id: "plan.list",
  description: "List the plans.",
  audience: ["app"],
  readOnly: true,
  run: () => Effect.succeed(null),
});
