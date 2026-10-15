/** A command line whose capability writes logs in each way that a program can, to test where they go. */
import { Console, Effect, Layer, Schema } from "effect";

import { App, Capability } from "../src/index.ts";
import { NodeCli } from "../src/node.ts";

const app = App.make({
  targets: { cli: { bindings: ["cli"] } },
  capabilities: [
    Capability.make({
      id: "probe.noisy.run",
      description: "Write logs, then give an answer.",
      audience: ["cli"],
      output: Schema.String,
      run: () =>
        Effect.gen(function* () {
          yield* Effect.logInfo("a log of Effect");
          yield* Console.log("a line of the console service");
          yield* Effect.sync(() => {
            console.log("a line of the global console");
            console.table([{ "a table of the global console": 1 }]);
            console.dir({ "an object of the global console": 1 });
          });
          return "the answer";
        }),
    }),
  ],
});

// After a run that succeeds, the program has its own console again.
process.once("beforeExit", () => {
  if ((process.exitCode ?? 0) === 0) console.log("after the run");
});

NodeCli.main(app, Layer.empty, { name: "probe", version: "0.0.0" });
