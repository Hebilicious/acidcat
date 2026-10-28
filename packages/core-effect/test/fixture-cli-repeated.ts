/**
 * A command line with one capability, `probe.plan`, that returns its input. Its input has a required repeated flag,
 * `--days`, with items that are a `$ref`, and an optional repeated flag, `--hours`.
 */
import { Effect, Layer, Schema } from "effect";

import { App, Capability } from "../src/index.ts";
import { NodeCli } from "../src/node.ts";

const Day = Schema.Literals(["mon", "tue"]).annotate({ identifier: "Day" });
const Plan = Schema.Struct({ days: Schema.Array(Day), hours: Schema.optionalKey(Schema.Array(Schema.Int)) });

const app = App.make({
  targets: { cli: { bindings: ["cli"] } },
  capabilities: [
    Capability.make({
      id: "probe.plan",
      description: "Return the days and the hours.",
      audience: ["cli"],
      input: Plan,
      output: Plan,
      run: (input) => Effect.succeed(input),
    }),
  ],
});

NodeCli.main(app, Layer.empty, { name: "probe", version: "0.0.0" });
