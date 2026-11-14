# A capability in each core

Each example is the same capability: `aircon.power.set` turns the unit on or off, for the targets `cli` and `mcp`, and can fail with `Offline`. The README of each core has the full API:

- core-ts: https://github.com/Hebilicious/acidcat/blob/main/packages/core-ts/README.md
- core-effect: https://github.com/Hebilicious/acidcat/blob/main/packages/core-effect/README.md
- core-rust: https://github.com/Hebilicious/acidcat/blob/main/packages/core-rust/README.md

## core-ts

```ts
import { writeFile } from "node:fs/promises";
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

- `subscribe` gets the decoded input and `{ signal, context, cursor, maxAgeMs }`. The session rejects a `maxAgeMs` that is not an integer of 0 or more as `invalid-input`, so the source gets only a valid one. It gives an async iterable of `{ data, eventId?, timestamp?, cursor?, truncated? }`. The signal aborts when the subscription ends: stop the work then.
- The session checks each `data` against the payload schema. Data that does not agree, or an iterable that throws, ends the subscription with `internal`. When the iterable ends, the subscription is complete.
- When the source can replay, give each occurrence a `cursor`, and start after `cursor` when it is given. Poll leases, webhook subscriptions and `watch --cursor` resume with it. With no cursor, a client that comes back gets only new occurrences: for example, the first poll after a lease ended gets `truncated: true`.
- A poll lease or a webhook subscription holds its subscription in a session of its own, with the context of the request that started it. With `createContext`, that context lives as long as the lease or the subscription.
- `session.eventHandle(statusChanged).subscribe({})` gives an async iterator of occurrences. Its `return()` cancels the subscription, also while a `next()` waits. A GraphQL `subscribe` resolver can return this promise.

## core-effect

```ts
import { writeFile } from "node:fs/promises";
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

An event is a `Stream` of the things that happen:

```ts
import { Event } from "@acid-cat/core-effect";
import { Schema, Stream } from "effect";

export const statusChanged = Event.make({
  id: "aircon.status.changed",
  description: "The status of the unit changed. The occurrence gives the new status.",
  audience: ["app", "mcp"],
  payload: Status, // a Schema.Struct
  subscribe: (_input, resume) => Unit.statusChanges.pipe(Stream.map((status) => ({ data: status }))),
});

export const aircon = App.make({ targets, capabilities: [powerSet], events: [statusChanged] });
```

- The stream has no error channel. Put the problems of the source in the payload. A defect ends the subscription with `internal`.
- The client cancels by interruption. Release the source with `Stream.ensuring` or a scoped resource.
- `session.follow(event, input)` gives a typed `Stream` of occurrences in a scope. `session.event(event).subscribe(input)` of `Handles.open` gives an async iterable, which a GraphQL `subscribe` resolver can return.
- `Mcp.toWebHandler` serves push and poll. Set `principal: (request) => Effect<Option<string>>` so that each client has its own poll leases. For webhooks, add `webhooks: { sender: NodeWebhook.sender() }` from `@acid-cat/core-effect/NodeWebhook`; it needs `principal`. Call `handler.dispose()` to end the leases and the webhook subscriptions. `Mcp.handle` keeps no state, so it serves only push; use `Mcp.makeHandle` in its place.
- An MCP server of your own, with `effect/ai/McpServer`, serves the events of the application with `Mcp.withEvents(app, layer, server, options)`: it answers the requests of the events extension, and gives each other request to your server. Give your server `extensions: Mcp.eventsExtensions`, so that `server/discover` declares the extension. Do not write the events methods yourself.

## core-rust

The crate `acid-cat-core`. Types give the schemas: each input, value, failure and payload derives `serde` and `schemars::JsonSchema`. Declare type aliases with the services of the application, so that the work of each capability knows their type.

```rust
use acid_cat_core::{App, Availability, Emitted, fail};
use schemars::JsonSchema;
use serde::{Deserialize, Serialize};
use tokio::sync::watch;

struct Unit {
    online: watch::Sender<Availability>,
}

type Capability = acid_cat_core::Capability<Unit>;
type Event = acid_cat_core::Event<Unit>;

#[derive(Deserialize, JsonSchema)]
struct Power {
    on: bool,
}

#[derive(Serialize, JsonSchema)]
#[serde(tag = "_tag")]
enum Failures {
    Offline {},
}

#[derive(Serialize, JsonSchema)]
struct Status {
    power: bool,
}

let aircon = App::new()
    .target("cli", ["cli"])
    .target("mcp", ["mcp"])
    .capability(
        Capability::new("aircon.power.set", "Turn the unit on or off.")
            .audience(["cli", "mcp"])
            .input::<Power>()
            .failures::<Failures>()
            .run(|Power { on }, call| async move {
                if !call.context().online.borrow().is_available() {
                    return fail(Failures::Offline {});
                }
                Ok(())
            }),
    )
    .event(
        Event::new("aircon.status.changed", "The status of the unit changed. The occurrence gives the new status.")
            .audience(["mcp"])
            .payload::<Status>()
            .subscribe(|(), subscription| futures::stream::iter([Ok(Emitted::new(Status { power: true }))])),
    )
    .build()?;
```

- `run` gives `Ok(value)`, `fail(failure)`, or an error with `?`, which is a defect: the call failure `internal`. A panic is a defect too.
- With no `input`, the work gets `()`. With no `output`, it gives `()`, and the value is `null`.
- An `Option` field is an optional property. Add `#[serde(skip_serializing_if = "Option::is_none")]` to the fields of a value, because a value must agree with the output schema.
- When a call is cancelled, the core drops the future of the work. Release resources in `Drop`, not after an `await`.
- The provider of an event gives a `Stream` of `Result<Emitted<P>, Defect>`. The end of the stream is complete. An `Err` is `internal`. When the client cancels, the core drops the stream.
- `state(|unit| unit.status.subscribe())` gives the state of a capability from a `tokio::sync::watch::Receiver`. A `watch` keeps only the last value, so do not use it for an event.
- For an event that the application publishes once to each subscription, use `EventLog<P>`: `log.publish(data).await` in the work, and `.subscribe(move |(), subscription| log.subscribe(&subscription))` as the provider. Each occurrence has a cursor, and a client resumes after it. `EventLog::in_memory(capacity)` keeps the last occurrences in memory. To resume after a restart, implement `EventStore` on a database or a file, with an `epoch` that stays the same, and use `EventLog::open(store)`. The payload type also derives `Deserialize`.
- `build()` checks the application and gives `Arc<Application<C>>`. `render_catalog()` gives the catalog in canonical form. A type with a `title` used in two or more places becomes a shared type in `$defs`.
- Bindings: `mcp::McpBinding` (MCP through HTTP, with the handshake, poll, and webhooks with `McpOptions::webhooks` and `principal`), `mcp::serve_stdio`, `http::HttpBinding`, `cli::cli_main`. `remote::serve(address, routes)` serves the remote bindings with hyper. The core has no WebMCP binding and no language binding: Rust code in the same process uses `Session::open`, `invoke` and `subscribe`.
