import { Effect, Layer, Schema } from "effect";

import * as App from "../src/App.ts";
import * as Capability from "../src/Capability.ts";
import * as NodeCli from "../src/NodeCli.ts";

const Name = Schema.Struct({ constructor: Schema.String, text: Schema.optionalKey(Schema.String) });

const app = App.make({
  targets: { cli: { bindings: ["cli"], options: { cli: { aliases: { go: { capability: "probe.name", input: { constructor: "fixed" } } } } } } },
  capabilities: [
    Capability.make({
      id: "probe.name",
      description: "Return the input.",
      audience: ["cli"],
      input: Name,
      output: Name,
      run: (input) => Effect.succeed(input),
    }),
  ],
});

NodeCli.main(app, Layer.empty, { name: "probe", version: "0.0.0" });
