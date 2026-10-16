/**
 * The types of `Capability.make`. `moon run core-effect:typecheck` checks this file: each `@ts-expect-error` marks a
 * program that the types must reject.
 */
import { test } from "node:test";

import type { Availability } from "@acid-cat/spec-ts";
import { Context, Effect, Schema, SubscriptionRef } from "effect";

import { Capability } from "../src/index.ts";

class Connection extends Context.Service<Connection, SubscriptionRef.SubscriptionRef<Availability>>()("probe/Connection") {}
class Progress extends Context.Service<Progress, SubscriptionRef.SubscriptionRef<string>>()("probe/Progress") {}
class Store extends Context.Service<Store, { readonly save: Effect.Effect<void> }>()("probe/Store") {}

/** `true` when `A` and `B` are the same type. */
type Equals<A, B> = (<T>() => T extends A ? 1 : 2) extends <T>() => T extends B ? 1 : 2 ? true : false;

const save = Capability.make({
  id: "probe.save",
  description: "Save the document.",
  audience: ["app"],
  availability: Connection,
  state: { schema: Schema.String, value: Progress },
  run: () => Effect.flatMap(Store, (store) => store.save).pipe(Effect.as(null)),
});

test("Capability.make keeps the literal id", () => {
  const id: "probe.save" = save.id;
  // @ts-expect-error The id is "probe.save".
  const other: "probe.load" = save.id;
  void [id, other];
});

test("Capability.make needs the services of availability, state and run", () => {
  const services: Equals<Capability.Services<typeof save>, Connection | Progress | Store> = true;
  void services;
});
