/** A capability that a lazy capability loads. Evaluating this module counts, so a test can tell when it is loaded. */
import { Effect, Schema } from "effect";

import { Capability } from "../src/index.ts";

const evaluations = globalThis as { lazyProbeEvaluations?: number };
evaluations.lazyProbeEvaluations = (evaluations.lazyProbeEvaluations ?? 0) + 1;

const Plan = Schema.Struct({ stops: Schema.Int, label: Schema.String }).annotate({ identifier: "Plan" });
const TooFar = Schema.TaggedStruct("TooFar", { stops: Schema.Int });

export const generate = Capability.make({
  id: "plan.generate",
  description: "Make a plan with some stops.",
  audience: ["app", "mcp"],
  readOnly: true,
  input: Schema.Struct({ stops: Schema.Int }),
  output: Plan,
  failures: [TooFar],
  run: ({ stops }) => (stops > 10 ? Effect.fail(TooFar.make({ stops })) : Effect.succeed({ stops, label: `${stops} stops` })),
});
