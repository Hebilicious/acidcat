/** The command line of the fixture whose `fixture.echo` never answers, for the guard tests. */
import { writeFile } from "node:fs/promises";

import { Effect, Layer, SubscriptionRef } from "effect";

import { NodeCli } from "../src/node.ts";
import { holdsLayer, Switch } from "./fixture.ts";
import { fixtureNeverAnswering } from "./fixture-ignoring.ts";

const services = Layer.merge(
  Layer.effect(Switch, SubscriptionRef.make(true)),
  holdsLayer((path) => Effect.promise(() => writeFile(path, ""))),
);

NodeCli.main(fixtureNeverAnswering, services, { name: "fixture", version: "0.0.0" });
