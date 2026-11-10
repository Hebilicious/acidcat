# A capability in each core

Each example is the same capability: `aircon.power.set` turns the unit on or off, for the targets `cli` and `mcp`, and can fail with `Offline`. The README of each core has the full API:

- core-ts: https://github.com/Hebilicious/acidcat/blob/main/packages/core-ts/README.md
- core-effect: https://github.com/Hebilicious/acidcat/blob/main/packages/core-effect/README.md

## core-ts

```ts
import { capabilitiesFor, defineApp, fail, ok, renderCatalog } from "@acid-cat/core-ts";
import { z } from "zod";

const Offline = z.object({ _tag: z.literal("Offline") });
const capability = capabilitiesFor<{ unit: Unit }>();

export const powerSet = capability({
  id: "aircon.power.set",
  description: "Turn the unit on or off.",
  audience: ["cli", "mcp"],
  input: z.object({ on: z.boolean() }),
  failures: { Offline },
  run: async ({ on }, { context, signal }) => ((await context.unit.setPower(on, signal)) ? ok(null) : fail({ _tag: "Offline" })),
});

export const aircon = defineApp<{ unit: Unit }>({
  targets: { cli: { bindings: ["cli"] }, mcp: { bindings: ["mcp"] } },
  capabilities: [powerSet],
});

const toJsonSchema = (schema) => z.toJSONSchema(schema, { target: "draft-2020-12" });
await writeFile("acidcat.catalog.json", renderCatalog(aircon, { toJsonSchema }));
```

- `run` gets the decoded input, the `AbortSignal` of the call and the context. It returns `ok(value)` or `fail(failure)`.
- `availability: (context) => observable` makes the capability available or not. `state: { schema, source }` gives a value that clients observe.

### An event in core-ts

```ts
import { eventsFor } from "@acid-cat/core-ts";

const event = eventsFor<{ unit: Unit }>();

export const statusChanged = event({
  id: "aircon.status.changed",
  description: "The status of the unit changed. The occurrence gives the new status.",
  audience: ["app", "mcp"],
  payload: Status, // an object schema
  async *subscribe(_input, { context, signal }) {
    for await (const status of context.unit.changes(signal)) yield { data: status };
  },
});

export const aircon = defineApp<{ unit: Unit }>({ targets, capabilities: [powerSet], events: [statusChanged] });
```

- `subscribe` gets the decoded input and `{ signal, context, cursor, maxAgeMs }`. It gives an async iterable of `{ data, eventId?, timestamp?, cursor?, truncated? }`. The signal aborts when the subscription ends: stop the work then.
- The session checks each `data` against the payload schema. Data that does not agree, or an iterable that throws, ends the subscription with `internal`. When the iterable ends, the subscription is complete.
- When the source can replay, give each occurrence a `cursor`, and start after `cursor` when it is given. Poll leases, webhook subscriptions and `watch --cursor` resume with it. With no cursor, a client that comes back gets only new occurrences: for example, the first poll after a lease ended gets `truncated: true`.
- A poll lease or a webhook subscription holds its subscription in a session of its own, with the context of the request that started it. With `createContext`, that context lives as long as the lease or the subscription.
- `session.eventHandle(statusChanged).subscribe({})` gives an async iterator of occurrences. Its `return()` cancels the subscription, also while a `next()` waits. A GraphQL `subscribe` resolver can return this promise.

## core-effect

```ts
import { App, Capability } from "@acid-cat/core-effect";
import { Schema } from "effect";

const Offline = Schema.TaggedStruct("Offline", {});

export const powerSet = Capability.make({
  id: "aircon.power.set",
  description: "Turn the unit on or off.",
  audience: ["cli", "mcp"],
  input: Schema.Struct({ on: Schema.Boolean }),
  failures: [Offline],
  run: ({ on }) => Unit.setPower(on), // an Effect that can fail with Offline
});

export const aircon = App.make({
  targets: { cli: { bindings: ["cli"] }, mcp: { bindings: ["mcp"] } },
  capabilities: [powerSet],
});

await writeFile("acidcat.catalog.json", App.render(aircon));
```

- A failure is a `Schema.TaggedStruct`. Use `Schema.Finite` or `Schema.Int` for numbers, because `Schema.Number` accepts `Infinity` and `NaN`.
- Services are layers. Make each `SubscriptionRef` of availability or state in a layer, so that all sessions share it.
- Give a shared type an `identifier` annotation. It becomes a named type in `$defs`.
