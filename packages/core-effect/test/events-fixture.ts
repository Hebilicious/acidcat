/** A test application with one event for each behavior of subscriptions that the tests examine. */
import { Context, Effect, Layer, PubSub, Schema, Stream, SubscriptionRef } from "effect";

import * as App from "../src/App.ts";
import * as Capability from "../src/Capability.ts";
import * as Event from "../src/Event.ts";

/** One tick that a test publishes. */
export interface Tick {
  readonly room: string;
  readonly count: number;
}

/** The ticks that the tests publish, and the number of subscriptions that follow them now. */
export class Feed extends Context.Service<
  Feed,
  {
    readonly ticks: PubSub.PubSub<Tick>;
    readonly following: SubscriptionRef.SubscriptionRef<number>;
  }
>()("events-fixture/Feed") {}

export const feedLayer = Layer.effect(
  Feed,
  Effect.all({ ticks: PubSub.unbounded<Tick>(), following: SubscriptionRef.make(0) }),
);

/** Publish one tick. */
export const publish = (tick: Tick) => Feed.use((feed) => PubSub.publish(feed.ticks, tick));

/** Wait until exactly `count` subscriptions follow the ticks. */
export const following = (count: number) =>
  Feed.use((feed) => SubscriptionRef.changes(feed.following).pipe(Stream.filter((now) => now === count), Stream.runHead));

/** The services of the fixture, and a function that waits for the subscriptions, for code that does not use Effect. */
export function feedForPromises() {
  const feed = Effect.runSync(Effect.all({ ticks: PubSub.unbounded<Tick>(), following: SubscriptionRef.make(0) }));
  return {
    layer: Layer.succeed(Feed, feed),
    following: (count: number) => Effect.runPromise(following(count).pipe(Effect.provideService(Feed, feed))),
    publish: (tick: Tick) => Effect.runPromise(publish(tick).pipe(Effect.provideService(Feed, feed))),
  };
}

/** The ticks, while a subscription follows them. The count of followers changes when the stream starts and ends. */
const ticks = Stream.unwrap(
  Effect.gen(function* () {
    const feed = yield* Feed;
    const subscription = yield* Effect.acquireRelease(
      Effect.tap(PubSub.subscribe(feed.ticks), () => SubscriptionRef.update(feed.following, (count) => count + 1)),
      () => SubscriptionRef.update(feed.following, (count) => count - 1),
    );
    return Stream.fromSubscription(subscription);
  }),
);

const Ticked = Schema.Struct({ room: Schema.String, count: Schema.Int });

const everywhere = ["app", "mcp", "cli", "api"];

export const ticked = Event.make({
  id: "feed.ticked",
  description: "A test published a tick. With a room, only the ticks of that room.",
  audience: everywhere,
  input: Schema.Struct({ room: Schema.optionalKey(Schema.String) }),
  payload: Ticked,
  subscribe: ({ room }) =>
    ticks.pipe(
      Stream.filter((tick) => room === undefined || tick.room === room),
      Stream.map((tick) => ({ data: tick, cursor: String(tick.count) })),
    ),
});

/** An event whose input schema has no top-level properties. */
export const counted = Event.make({
  id: "feed.counted",
  description: "Give one occurrence for each key of the input, in order, with its number, then end.",
  audience: everywhere,
  input: Schema.Record(Schema.String, Schema.Int),
  payload: Schema.Struct({ key: Schema.String, value: Schema.Int }),
  subscribe: (input) => Stream.fromIterable(Object.entries(input).map(([key, value]) => ({ data: { key, value }, eventId: key }))),
});

export const timed = Event.make({
  id: "feed.timed",
  description: "Give one occurrence every few milliseconds. With a count, end after that number of occurrences.",
  audience: everywhere,
  input: Schema.Struct({ every: Schema.Int, count: Schema.optionalKey(Schema.Int) }),
  payload: Schema.Struct({ index: Schema.Int }),
  subscribe: ({ every, count }) => {
    const all = Stream.iterate(0, (index) => index + 1).pipe(Stream.mapEffect((index) => Effect.as(Effect.sleep(every), { data: { index } })));
    return count === undefined ? all : Stream.take(all, count);
  },
});

export const resumed = Event.make({
  id: "feed.resumed",
  description: "Give one occurrence with the cursor and maxAgeMs of the subscription, then end.",
  audience: everywhere,
  payload: Schema.Struct({ cursor: Schema.optionalKey(Schema.String), maxAgeMs: Schema.optionalKey(Schema.Int) }),
  subscribe: (_input, resume) => Stream.make({ data: resume, cursor: "after" }),
});

export const crashing = Event.make({
  id: "feed.crashing",
  description: "Give one occurrence, then fail with a defect.",
  audience: everywhere,
  subscribe: () => Stream.concat(Stream.make({ data: {} }), Stream.die(new Error("secret internal detail"))),
});

export const disagreeing = Event.make({
  id: "feed.disagreeing",
  description: "Give one good occurrence, then one whose payload does not agree with the payload schema.",
  audience: everywhere,
  payload: Ticked,
  subscribe: () => Stream.make({ data: { room: "a", count: 1 } }, { data: { room: "a", count: 1.5 } }),
});

export const hiddenEvent = Event.make({
  id: "feed.hidden",
  description: "Only the app target can follow this event.",
  audience: ["app"],
  subscribe: () => Stream.never,
});

export const events = App.make({
  title: "Events fixture",
  description: "One event for each behavior of subscriptions.",
  targets: {
    app: { bindings: ["typescript"] },
    mcp: { bindings: ["mcp"] },
    cli: { bindings: ["cli"] },
    api: { bindings: ["http"] },
  },
  capabilities: [
    Capability.make({
      id: "feed.publish",
      description: "Publish a tick.",
      audience: everywhere,
      input: Ticked,
      run: (tick) => Effect.as(publish(tick), null),
    }),
  ],
  events: [ticked, counted, timed, resumed, crashing, disagreeing, hiddenEvent],
});
