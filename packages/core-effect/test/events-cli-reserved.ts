#!/usr/bin/env node
/** A command line with an event whose input has a property `cursor`, which is a flag of `watch`. It must not start. */
import { Layer, Schema, Stream } from "effect";

import { App, Event } from "../src/index.ts";
import { NodeCli } from "../src/node.ts";

// The first argument chooses the name of the property. The other arguments go to the command line.
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
