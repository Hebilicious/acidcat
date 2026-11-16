#!/usr/bin/env node
import { Layer, Schema, Stream } from "effect";

import * as App from "../src/App.ts";
import * as Event from "../src/Event.ts";
import * as NodeCli from "../src/NodeCli.ts";

const name = process.argv[2] === "max-age-ms" ? "max-age-ms" : "cursor";
process.argv.splice(2, 1);

const app = App.make({
  title: "Reserved",
  description: "An event with an input property that has the name of a flag of watch.",
  targets: { cli: { bindings: ["cli"] } },
  capabilities: [],
  events: [
    Event.make({
      id: "reserved.changed",
      description: "Never gives an occurrence.",
      audience: ["cli"],
      input: Schema.Struct({ [name]: Schema.optionalKey(Schema.String) }),
      subscribe: () => Stream.never,
    }),
  ],
});

NodeCli.main(app, Layer.empty, { name: "reserved", version: "0.0.0" });
