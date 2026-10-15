#!/usr/bin/env node
/** The fixture as a command line, for the CLI tests. A call to `fixture.hold` with a marker creates the marker file. */
import { writeFile } from "node:fs/promises";

import { Effect, Layer, SubscriptionRef } from "effect";

import { NodeCli } from "../src/node.ts";
import { fixture, holdsLayer, Switch } from "./fixture.ts";

const services = Layer.merge(
  Layer.effect(Switch, SubscriptionRef.make(true)),
  holdsLayer((path) => Effect.promise(() => writeFile(path, ""))),
);

NodeCli.main(fixture, services, { name: "fixture", version: "0.0.0" });
