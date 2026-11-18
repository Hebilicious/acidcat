# @acid-cat/core-effect

An AcidCat core for people who write [Effect](https://effect.website). You declare capabilities and events in TypeScript, the package writes the catalog from them, and it serves them through every binding: TypeScript handles, MCP, HTTP, CLI and WebMCP.

Everything is Effect. A capability is an Effect program with Effect Schema types, an event is a `Stream`, a session is a scope, the application's services are layers, and a cancellation interrupts a fiber. If you do not use Effect, use [`@acid-cat/core-ts`](../core-ts) instead. This package is one implementation of the [specification](../../spec/README.md) among others, and every core has the same features and passes `acid-cat conform`.

```sh
pnpm add @acid-cat/core-effect effect
pnpm add @effect/platform-node  # only for NodeCli and NodeMcp, from @acid-cat/core-effect/node
```

`effect` and `@effect/platform-node` are peer dependencies, so the application and the core share one Effect. The package supports Effect 4.

## Quick start

This program declares one capability and serves it as a command line:

```ts
// greeter.ts
import { App, Capability } from "@acid-cat/core-effect";
import { NodeCli } from "@acid-cat/core-effect/node";
import { Effect, Layer, Schema } from "effect";

const greet = Capability.make({
  id: "greeting.say",
  description: "Say hello to a person.",
  audience: ["cli"],
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  run: ({ name }) => Effect.succeed({ message: `Hello, ${name}.` }),
});

export const greeter = App.make({
  title: "Greeter",
  targets: { cli: { bindings: ["cli"] } },
  capabilities: [greet],
});

NodeCli.main(greeter, Layer.empty, { name: "greeter", version: "0.1.0" });
```

```sh
$ node greeter.ts greeting say --name Ada
{
  "message": "Hello, Ada."
}
```

`App.render(greeter)` gives the catalog in canonical form (see [Write the catalog](#write-the-catalog)). To serve the same capability through MCP or HTTP, add a target with that binding and use the module in [Serve the capabilities](#serve-the-capabilities).

## Write capabilities

```ts
import { App, Capability } from "@acid-cat/core-effect";
import { Effect, Schema } from "effect";

const Offline = Schema.TaggedStruct("Offline", {});

export const aircon = App.make({
  title: "Living-room air conditioner",
  targets: { cli: { bindings: ["cli"] }, mcp: { bindings: ["mcp"] } },
  capabilities: [
    Capability.make({
      id: "aircon.power.set",
      description: "Turn the unit on or off.",
      audience: ["cli", "mcp"],
      input: Schema.Struct({ on: Schema.Boolean }),
      failures: [Offline],
      run: ({ on }) => Unit.setPower(on), // an Effect that can fail with Offline
    }),
  ],
});
```

Declare each capability with `Capability.make`. Its options:

- `input` is a `Schema.Struct`, or a `Schema.Union` of structs. The catalog writes a union with `"type": "object"`, so it is an object schema. With no `input`, `run` gets the object that the client sent, as a `Capability.NoInput`.
- For numbers, use `Schema.Finite` or `Schema.Int`. `Schema.Number` also accepts `Infinity` and `NaN`, which JSON cannot hold.
- Each failure is a `Schema.TaggedStruct`. Its tag is the tag in the catalog.
- `readOnly`, `destructive` and `idempotent` are optional boolean [hints](../../spec/catalog.md#capabilities) for clients. The MCP binding gives them as the tool annotations `readOnlyHint`, `destructiveHint` and `idempotentHint`.
- `availability` is an optional Effect that gives a `SubscriptionRef` of availability values. Without it, the capability is always available.
- `state` is an optional `{ schema, value }`: the [state](../../spec/invocation.md#state) schema, and an Effect that gives a `SubscriptionRef` of its values. Handles need a state schema that encodes synchronously, because `getSnapshot` is synchronous. If it does not, `Handles.make` fails with an error that names the capability.
- Give a shared type an `identifier` annotation. It becomes a named type in `$defs`.

`Capability.make` also does this:

- It builds the capability's `pipeline`: the calls that a session makes when it does not know the schemas' types. Each part checks its values with the schemas of the same capability.
- It keeps the literal type of `id`, so an application can type its ids, for example `typeof powerSet.id`.
- The capability needs the services that `run`, `availability` and `state` need.

### Read the session's target

A capability's work reads its session's target with `yield* Session.Target` (see [Sessions](../../spec/invocation.md#sessions)). Availability, state and event providers read it the same way. Each session provides `Session.Target`, so it is not one of the services that the application must give. Outside a session, its value is the empty string.

```ts
export const whoGet = Capability.make({
  id: "who.get",
  description: "Give the target of the call.",
  audience: ["api", "mcp"],
  output: Schema.Struct({ target: Schema.String }),
  run: () => Effect.map(Session.Target, (target) => ({ target })),
});
```

### Availability and state

A session gets each availability ref and each state ref once, when it opens. It starts no fiber. It reads the availability ref when a call comes in, so a call after `SubscriptionRef.set` sees the new value. `session.changes` and `session.state(id)` follow the refs only while they run. A handle follows its refs only while it has listeners.

Make each ref in a layer, so all sessions share it. If the source is a `Stream`, follow it once in that layer, and fork the follower with `startImmediately: true` so it subscribes before the layer is built. A follower that starts later loses the changes that the source gives before it subscribes, for example from a `PubSub`:

```ts
import { AVAILABLE } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";

class Connection extends Context.Service<Connection, SubscriptionRef.SubscriptionRef<Availability>>()("app/Connection") {}

const connectionLayer = Layer.effect(
  Connection,
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make<Availability>(AVAILABLE);
    // `connectionChanges` is a Stream<Availability>. The fiber subscribes to it now, and stops when the layer is released.
    yield* connectionChanges.pipe(
      Stream.runForEach((value) => SubscriptionRef.set(ref, value)),
      Effect.forkScoped({ startImmediately: true }),
    );
    return ref;
  }),
);

export const firmwareUpdate = Capability.make({
  id: "aircon.firmware.update",
  description: "Install the latest firmware.",
  audience: ["app"],
  availability: Connection,
  run: () => Effect.succeed(null),
});
```

## Write events

An [event](../../spec/events.md) is something that happens and that clients follow. `Event.make` declares it, and `subscribe` gives a `Stream` of its occurrences:

```ts
import { App, Event } from "@acid-cat/core-effect";
import { Schema, Stream } from "effect";

const Status = Schema.Struct({ power: Schema.Boolean, celsius: Schema.Int }).annotate({ identifier: "Status" });

export const statusChanged = Event.make({
  id: "aircon.status.changed",
  description: "The status of the unit changed.",
  audience: ["app", "mcp"],
  input: Schema.Struct({}),
  payload: Status,
  subscribe: () => Unit.statusChanges.pipe(Stream.map((status) => ({ data: status }))),
});

export const aircon = App.make({ targets, capabilities: [powerSet], events: [statusChanged] });
```

- `input` is a `Schema.Struct`, with the same rules as a capability's input. `subscribe` gets the decoded input and `resume`: the client's `cursor` and `maxAgeMs` (see [Resuming](../../spec/events.md#resuming)). With no cursor, start now.
- `payload` is a `Schema.Struct` or another object schema. With no payload, each occurrence's data is an empty object.
- Each stream value is an `Emitted`: `data`, and optionally `eventId`, `timestamp`, `cursor` and `truncated`. The session makes the `eventId` and `timestamp` when the provider gives none. Pass the source's `eventId` when it has one.
- The stream has no error channel. Put source problems in the payload, for example as a union with a `_tag`. A stream defect, or a payload that does not match the payload schema, ends the subscription with the call failure `internal`. The details go to the log, not to the client.
- A subscription ends when the stream completes, when the client cancels it (the stream's fiber is interrupted), or when the session closes (the stream completes). Release the source's resources with `Stream.ensuring` or a scoped resource.
- The stream starts in a session fiber before `subscribe` returns, and runs until it first waits. So a stream that subscribes to a `PubSub` without waiting gets every value published after `subscribe` returns. A stream that waits before it subscribes, for example on an asynchronous effect, misses the values published before it subscribes.
- Capabilities and events share one set of ids. `App.document` throws when an id is both, or when a payload is not an object.

## Write the catalog

```ts
import { writeFile } from "node:fs/promises";
import { App } from "@acid-cat/core-effect";

await writeFile("acidcat.catalog.json", App.render(aircon)); // canonical form
```

The catalog has an `events` member when the application has events.

## Serve the capabilities

| Module | Binding | Entry point |
| --- | --- | --- |
| `Session` | [Invocation](../../spec/invocation.md), [Events](../../spec/events.md) | `Session.make(app, { target })` gives a `Session<R>`, where `R` is the application's services. It has `invoke` for untrusted input by id, [typed calls](#typed-calls) and [subscriptions](#follow-events) |
| `Handles` | [TypeScript](../../spec/bindings/typescript.md) | For code that does not use Effect, such as a user interface. `Handles.make(app, session)` gives handles with promises and observables. `Handles.makeEvents(app, session)` gives event handles with async iterables. `Handles.open(app, layer, { target, webmcp })` opens a session (see [Handles](#handles-for-code-without-effect)) |
| `Mcp` | [MCP](../../spec/bindings/mcp.md) | Through HTTP: `Mcp.toWebHandler(app, layer, options)`, or `Mcp.makeHandle(app, options)` for a host that builds the services itself. `Mcp.withHandshake(handler)` also serves the [`initialize` handshake of earlier revisions](../../spec/bindings/mcp.md#earlier-revisions-through-http), from [`@acid-cat/mcp-handshake`](../mcp-handshake). Through stdio: `Mcp.serveStdio(app, options)`, and `NodeMcp.main(app, layer, options)` from `@acid-cat/core-effect/node` (see [MCP through stdio](#mcp-through-stdio)). Both run on `effect/ai/McpServer` |
| `Http` | [HTTP](../../spec/bindings/http.md) | `Http.toWebHandler(app, layer, options)`. `Http.client(base, options)` is a client of the binding, for a [command line that calls a server](#command-line-that-calls-a-server) |
| `Remote` | [Remote bindings](../../spec/bindings/README.md#remote-bindings) | `Remote.IncomingRequest` (the request head, for per-request services) and `Remote.refuse(status, message, headers)`. See [Services for each request](#services-for-each-request) |
| `Cli` | [CLI](../../spec/bindings/cli.md) | `Cli.run(app, options)`, on `effect/cli`. `NodeCli.main(app, layer, options, args?)` from `@acid-cat/core-effect/node` runs it as a Node.js process's main program. `args` defaults to `process.argv.slice(2)` |
| `WebMcp` | [WebMCP](../../spec/bindings/webmcp.md) | `WebMcp.install(session)`. WebMCP serves no events |
| `NodeServer` | MCP and HTTP | `NodeServer.serve(handler, options)` and `NodeServer.layer(handler, options)` serve web handlers on Node.js. See [Serve on Node.js](#serve-on-nodejs) |
| `NodeWebhook` | MCP | `NodeWebhook.sender(options)` sends webhook delivery requests from Node.js. See [Webhook delivery](#webhook-delivery) |

`layer` gives the services that the capabilities need. A web handler is `(request: Request) => Promise<Response>`, and works in Node, Bun, Deno and Cloudflare Workers. When a request's signal aborts, the handler cancels that request's call.

### Serve on Node.js

`NodeServer` serves web handlers on Node.js with only `node:http`, and has no other dependency. The server runs in a scope.

```ts
import * as NodeServer from "@acid-cat/core-effect/NodeServer";
import { Effect, Layer } from "effect";

const mcp = Mcp.toWebHandler(aircon, unitLayer, mcpOptions);
const http = Http.toWebHandler(aircon, unitLayer, httpOptions);

Layer.launch(NodeServer.layer({ "/mcp": mcp, "/": http }, { port: 3000 })).pipe(Effect.runFork);
```

- `NodeServer.serve(handler, options)` is an Effect that needs a `Scope`. It gives the server's `url` and `port`, and the server closes when the scope closes.
- `NodeServer.layer(handler, options)` serves while the layer is built. `Layer.launch` runs it until the program is interrupted.
- Both fail with `ServeError` when the server cannot listen, for example when the port is in use.
- The handler is one handler for all paths, or handlers by path prefix. The longest matching prefix gets the request, and `/` matches all paths. The MCP handler answers on all paths, so give it its own prefix. A path that no prefix matches gets `404`. A handler that rejects gets `500`.
- When a client closes its connection, its request's signal aborts, so the handler cancels the call or subscription.
- The server sends the headers of a response with a body before the first chunk, so a server-sent events client gets the status before the first message.

| Option | Default | Use |
| --- | --- | --- |
| `port` | `3000` | The port. With `0`, the system picks a free port |
| `hostname` | `127.0.0.1` | The address. The default accepts connections only from the same computer. Use `0.0.0.0` or `::` to accept connections from the network |

`@acid-cat/core-effect/NodeServer` needs only Node.js. `@acid-cat/core-effect/node` exports `NodeServer` and `NodeWebhook` too, with `NodeCli` and `NodeMcp`, which need `@effect/platform-node`.

`NodeServer` is a plain HTTP/1.1 server, without HTTPS. When clients connect over a network, end TLS in the platform in front of the server: a load balancer, a Kubernetes ingress (for example with cert-manager for the certificates), or a tunnel such as Cloudflare Tunnel. The platform sends plain HTTP to the server on its private network, so set `hostname` to `0.0.0.0` or `::`. Do not put a TLS proxy in the process in front of `NodeServer`.

For more, give the handler to a web handler library such as [srvx](https://srvx.h3.dev): HTTPS in the process (when TLS must reach the server), HTTP/2, middleware, or the same server code on Bun and Deno. Make sure that the library aborts a request's signal when the client closes the connection. If it does not, a closed connection does not cancel the call.

### MCP through stdio

An MCP client, such as a coding agent, can start the server as a local process. `NodeMcp.main` serves a Node.js process's standard input and output:

```ts
#!/usr/bin/env node
import { NodeMcp } from "@acid-cat/core-effect/node";

NodeMcp.main(aircon, unitLayer, { name: "aircon", version: "1.0.0" });
```

- The process is one session. The server serves revision `2026-07-28`, and the `initialize` handshake of revisions `2025-11-25` and `2025-06-18`.
- When a capability's availability changes, the server sends `notifications/tools/list_changed`. `notifications/cancelled` interrupts the call.
- `Mcp.serveStdio(app, options)` is the server on the `effect` `Stdio` service, for any runtime. It completes when standard input ends. Then the session closes and calls in progress are interrupted. `Mcp.layerStdio(app, options)` is the same server as a layer that serves while its scope is open.
- Standard output carries only MCP messages, so Effect logs go to standard error. Do not write to standard output from a capability.
- When the view has events, the server serves the events extension to `2026-07-28` clients (see [Follow events](#follow-events)), with push and poll delivery. `notifications/cancelled` with an `events/stream` request's id cancels that subscription. The `poll` option sets the [poll leases](#poll-delivery). The process has no principal. Webhook delivery works only through HTTP, so `events/subscribe` and `events/unsubscribe` answer with `Unsupported`.

### Typed calls

A typed call takes the capability object and has its schemas' types. The session accepts only the capability object that it serves. Any other object, even one with the same id, is `unknown-capability`. The capability needs only the application's services.

| Effect `Session` | Input | Result |
| --- | --- | --- |
| `session.call(capability, input)` | Untrusted: the capability's input schema decodes it | `Effect<Value, Failure \| CallFailed>`. An input that does not decode is the call failure `invalid-input` |
| `session.execute(capability, input)` | Already decoded, with the input's type | `Effect<Value, Failure \| CallFailed>` |
| `session.outcome(capability, input)` | Already decoded, with the input's type | `Effect<Outcome<Value, Failure>>`, which never fails |

```ts
import { Session } from "@acid-cat/core-effect";

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* Session.make(aircon, { target: "mcp" });
    return yield* session.call(powerSet, { on: true }); // Effect<null, typeof Offline.Type | Session.CallFailed>
  }),
);
```

### Handles for code without Effect

`Handles.open` gives a session for code that does not use Effect, with the same method names:

- `session.call(capability, input)` decodes untrusted input and gives `Promise<Result<Value, Failure>>`. A call failure rejects with a `CallFailureError`; an input that does not decode rejects as `invalid-input`.
- `session.handle(capability)` gives the capability's handle, with its schemas' types. `execute` takes the decoded input and gives the decoded value or failure. `snapshot` gives the state in its JSON form. For a capability that the session does not serve, the handle is always unavailable, and each call rejects as `unknown-capability`.
- `session.handles` gives the handles by id, without the schemas' types, for bindings.
- `await using session = await Handles.open(…)` closes the session at the end of the block. `session.dispose()` closes it too.

```ts
import { Handles } from "@acid-cat/core-effect";

await using session = await Handles.open(aircon, unitLayer, { target: "app" });
const result = await session.call(powerSet, request.body); // Result<null, typeof Offline.Type>
const power = session.handle(powerSet); // Handles.HandleOf<typeof powerSet>
await power.execute({ on: true }); // Result<null, typeof Offline.Type>
```

With the `webmcp` option (a WebMCP host), the session also registers its tools on that host, and the tools close with the session. To use the page's host, pass `webmcp: WebMcp.findHost()`. Without the option, `session.webmcp` is `undefined`.

- `session.webmcp.status` observes the tools' status.
- `session.webmcp.retry()` asks for the last failed update again. Its promise resolves when the request is queued, not when the update ends. Watch `status` for the result.
- `session.webmcp.remove()` removes the tools from the host while the session stays open. After it, the session registers no more tools and `retry()` does nothing. The promise resolves when the tools are removed. Calls in progress continue, and the handles and services stay open, so a capability can call `remove()` during its own call. `status` is `closing` until the WebMCP calls in progress end, then `disposed`. A second `remove()` does nothing, and `dispose()` still works after it. The effect `remove` of `WebMcp.install`'s installation is the same operation.

```ts
import { Handles, WebMcp } from "@acid-cat/core-effect";

await using session = await Handles.open(aircon, unitLayer, { target: "app", webmcp: WebMcp.findHost() });
session.webmcp?.status.subscribe((status) => render(status.phase));
```

### Follow events

A subscription either starts, or fails with a call failure before the first occurrence:

- `cancelled` when the session is closing.
- `unknown-capability` when the event is not in the view.
- `invalid-input` when the input does not match the input schema, or `maxAgeMs` is not an integer of 0 or more.

Each binding follows the [events specification](../../spec/events.md) and its own binding document.

| Effect `Session` | Input | Result |
| --- | --- | --- |
| `session.subscribe(id, input, { cursor, maxAgeMs })` | Untrusted: the input schema decodes it | `Effect<Subscription<unknown>, CallFailed, Scope>`. Each `data` is in its JSON form |
| `session.follow(event, input, { cursor, maxAgeMs })` | Already decoded, with the input's type | `Effect<Subscription<Payload>, CallFailed, Scope>`. Each `data` is a copy, with the payload's type |

A `Subscription<Payload>` is a `Stream<Occurrence<Payload>, CallFailed>`. The scope is the subscription's lifetime: when the scope closes, the subscription is cancelled. Interrupting the stream also cancels it. The stream ends when the provider has no more occurrences or the session closes, and fails with `internal` when the provider fails. As with typed calls, the session accepts only the event object that it serves.

```ts
const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* Session.make(aircon, { target: "app" });
    const changes = yield* session.follow(statusChanged, {}); // Stream<Occurrence<typeof Status.Type>, CallFailed>
    yield* Stream.runForEach(changes, (occurrence) => Console.log(occurrence.data.celsius));
  }),
);
```

For each subscription, the session buffers up to `eventBuffer` occurrences that the client has not read. `eventBuffer` is an option of `Session.make`, `Handles.open` and the web handlers, and defaults to 1024. When the buffer is full, the session drops the oldest occurrence, and the next occurrence that the client reads has `truncated: true`.

#### Event handles

`session.events` (from `Handles.open`) gives the event handles by id. `session.event(event)` gives one event's handle, with its schemas' types.

- `subscribe(input, options)` gives `Promise<AsyncIterable<Occurrence<Payload>>>`. `subscribeExternal(input, options)` validates untrusted input.
- The promise resolves when the subscription has started, and rejects with a `CallFailureError` when it cannot start.
- The iterator's `return()` cancels the subscription, even while a `next()` waits; that `next()` resolves with `done: true`. `options.signal` and the end of the session also cancel it.
- When the provider fails, `next()` rejects with an error whose `kind` is `internal`, then resolves with `done: true`.

A GraphQL server can return the promise from a field's `subscribe` resolver, for subscriptions over WebSockets (graphql-ws) or server-sent events (GraphQL Yoga, graphql-sse):

```ts
const handle = session.event(statusChanged);
const Subscription = new GraphQLObjectType({
  name: "Subscription",
  fields: {
    statusChanged: {
      type: StatusType,
      subscribe: () => handle.subscribe({}),
      resolve: (occurrence: Occurrence<typeof Status.Type>) => occurrence.data,
    },
  },
});
```

#### Events over HTTP

- `GET {base}/events` lists the view's events.
- `POST {base}/events/{id}`, with the input as the body, gives a stream of server-sent events: `event: next` for each occurrence with the cursor as `id:`, then `event: complete`, or `event: error` with the call failure `internal`.
- A call failure before the stream starts is a JSON answer with its status.
- The `Last-Event-ID` header gives the cursor. The `maxAgeMs` query parameter gives `maxAgeMs`.
- When nothing goes on the stream for `keepaliveMs` (default 15 000), the binding sends a comment line.
- When the client closes the stream, the subscription is cancelled.

#### Events over MCP

When the view has events, the server serves the events extension, `io.modelcontextprotocol/events`, to `2026-07-28` clients. `server/discover` declares it, and `events/list` lists the events, each with its delivery modes. A client that uses the `initialize` handshake gets no events. The `effect/ai` server cannot add methods, so the binding answers the extension's requests before they reach that server.

- Push: `events/stream` subscribes. A subscription's messages are `notifications/events/active`, `notifications/events/event` for each occurrence, `notifications/events/heartbeat` when nothing goes on the stream for `heartbeatMs` (default 15 000), `notifications/events/terminated` for `internal`, and finally the result of `events/stream`. Through HTTP, the answer to `events/stream` is a server-sent events stream, and closing the request cancels the subscription. Through stdio, the messages go to standard output, and `notifications/cancelled` cancels the subscription.
- Poll: `events/poll` reads a poll lease, through HTTP and stdio. See [Poll delivery](#poll-delivery).
- Webhook: `events/subscribe` sends the occurrences to a client URL. It works only through HTTP, and only when the `webhooks` option is set. See [Webhook delivery](#webhook-delivery).

#### Poll delivery

A poll lease holds one subscription, in its own session, and a buffer of its occurrences. A lease's key is the principal, the event id and the input, so two polls with the same key read the same lease.

1. The first poll with no cursor starts the lease. It gives no occurrences and a cursor.
2. Each later poll gives the occurrences after its cursor, and a new cursor. The cursor identifies the lease, the position in its buffer, and the provider's last cursor.
3. After a lease ends, a poll with its cursor starts a new lease that resumes after that provider cursor, with `maxAgeMs`.

See [Poll](../../spec/bindings/mcp.md#poll) for all the rules.

| `poll` option | Default | Use |
| --- | --- | --- |
| `leaseMs` | `300000` | A lease that gets no poll for this long ends, and its subscription is cancelled |
| `bufferLimit` | `1000` | How many occurrences a lease keeps. When the buffer is full, the lease drops the oldest, and a poll with an older cursor gets `truncated: true` |
| `maxEvents` | `100` | How many occurrences a result holds when the request gives no `maxEvents`. With more, the result has `hasMore: true` |
| `nextPollMs` | `2000` | The `nextPollMs` of each result |

The `principal` option of `Mcp.toWebHandler` gives each request's client identity: `(request: Request) => Effect<Option<string>>`. Check the request's credentials in it, for example a bearer token. A lease belongs to the principal of the request that started it, so a client cannot read another principal's lease. With no principal, all clients with the same event id and input read the same lease.

Leases live in process memory:

- A lease opens its session with the services of the request that started it. With `services: "per-request"`, those services stay open until the lease ends.
- `handler.dispose()` (on the `Mcp.toWebHandler` result) ends all leases and webhook subscriptions, and releases the shared services.
- `Mcp.makeHandle(app, options)` gives a function that answers each request like `Mcp.handle`, and keeps the leases and webhook subscriptions in its scope.
- `Mcp.handle` keeps no state between requests, so it delivers only by push. `events/poll` and the webhook methods answer with `Unsupported`.
- Through stdio, leases live while the server runs.
- A server that restarts loses its leases. Clients poll again with their cursors.

#### Webhook delivery

With the `webhooks` option, the server sends each occurrence in an HTTP `POST` request to a client URL, signed with the [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) scheme. Webhook delivery is off by default and works only through HTTP. It needs the `principal` option: a request with no principal gets `Forbidden`.

```ts
import * as NodeWebhook from "@acid-cat/core-effect/NodeWebhook";

const mcp = Mcp.toWebHandler(aircon, unitLayer, {
  ...mcpOptions,
  principal: (request) => verifyBearerToken(request), // Effect<Option<string>>
  webhooks: { sender: NodeWebhook.sender() },
});
```

Subscribe:

- `events/subscribe` with `delivery: { mode: "webhook", url, secret }` starts a subscription in its own session, or renews the subscription with the same principal, URL, event id and input.
- The URL must use `https`. The secret must be `whsec_` followed by the base64 of 24 to 64 bytes.
- The server grants a `ttlMs` between `minTtlMs` and `maxTtlMs`. A renewal grants a new lifetime and replaces the secret. For `rotationGraceMs`, the server signs with both the old and the new secret.
- A subscription that is not renewed before `refreshBefore` ends. `events/unsubscribe` ends a subscription at once.

Verification:

- Before a principal's first subscription to a URL, the server sends `{ "type": "verification", "challenge" }`. The endpoint agrees when it answers with a `2xx` status and `{ "challenge" }` with the same text. Otherwise `events/subscribe` fails with `CallbackEndpointError` (`-32027`), with `data.reason`.
- The server remembers each verification while the process runs. A URL for which `allow` returns `true` needs no verification.

Delivery:

- The server sends one subscription's occurrences one at a time, in order. The body is the occurrence, with the watermark as its `cursor`: the cursor of the last occurrence whose delivery succeeded or was abandoned.
- `{ "type": "gap", "cursor" }` comes before an occurrence with `truncated: true`. `{ "type": "terminated", "error" }` ends a subscription that fails with `internal`.
- Each request has the headers `webhook-id`, `webhook-timestamp`, `webhook-signature` and `X-MCP-Subscription-Id`.
- After a status that is not `2xx`, the server retries with the same `webhook-id`, up to `attempts` times within `retryWindowMs`. `410` and `413` abandon the delivery at once.
- Each `events/subscribe` result has `deliveryStatus`, with `lastDeliveryAt` and the last failure's category in `lastError`.

| `webhooks` option | Default | Use |
| --- | --- | --- |
| `sender` | Required | Sends the requests. Use `NodeWebhook.sender(options)` on Node.js. A sender for another runtime is a function `(request) => Effect<WebhookResponse, WebhookSendError>` that follows the same network rules |
| `allow` | None | `(url: URL) => boolean`. The URLs that need no verification |
| `maxTtlMs` | `3600000` | The longest subscription lifetime |
| `minTtlMs` | `60000` | The shortest subscription lifetime |
| `maxSubscriptions` | `100` | The most subscriptions one principal can have. A new subscription over the limit gets `ResourceExhausted` (`-32025`) |
| `attempts` | `5` | The most attempts for one delivery |
| `retryWindowMs` | `900000` | After this long from a delivery's first attempt, the server makes no more attempts |
| `retryDelays` | 5 s, then 4 times longer each time | A `Schedule` of the waits between attempts |
| `timeoutMs` | `5000` | How long the server waits for each answer |
| `rotationGraceMs` | `300000` | How long after a secret change the server signs with both secrets |

A webhook URL comes from the client, so a request to it could reach the server's private network. `NodeWebhook.sender` guards against this:

- It resolves the URL's host name for each request, and connects only to a globally routable address.
- It connects to the address that it checked, with the host name in the `Host` header and in TLS, so a second DNS answer cannot change the address.
- It does not follow redirects.
- It reads at most `maxResponseBytes` of each answer.

| `NodeWebhook.sender` option | Default | Use |
| --- | --- | --- |
| `allowPrivateNetworks` | `false` | Also connect to loopback, private, link-local and other addresses that are not globally routable. Use it only for tests, or when every endpoint is in a network that you control |
| `ca` | None | PEM certificate authorities to trust in addition to Node.js's own, for example a test endpoint's |
| `maxResponseBytes` | `65536` | The most bytes of an answer that the sender reads |

The principal keeps clients apart: a subscription's key and each verification include it, so a client cannot renew, read the secret of, or end another principal's subscription. Subscriptions, verifications and limit counts live in process memory. A server that restarts loses them, and clients subscribe again with their last cursor.

#### Events beside your own MCP server

An MCP server with tools that you design, written with `effect/ai/McpServer`, can also serve the application's events. `Mcp.withEvents(app, layer, server, options)` wraps your server's web handler:

- It screens each request as `Mcp.toWebHandler` does.
- It answers each request of the `2026-07-28` events extension itself, with push, poll and (with the `webhooks` option) webhook delivery.
- It passes every other request to your server.

Give your server `Mcp.eventsExtensions` as its `extensions`, so `server/discover` declares the extension.

```ts
const server = McpServer.toolkit(MyTools).pipe(
  Layer.provide(handlers),
  Layer.provideMerge(McpServer.layerHttp({ name: "aircon", version: "0.1.0", path: "/mcp", protocols: [McpProtocol.v2026_07_28], extensions: Mcp.eventsExtensions })),
  Layer.provide(unit),
);
const application = HttpRouter.toWebHandler(server);
const mcp = Mcp.withEvents(aircon, unit, application.handler, { allowedOrigins: [] });
```

`Mcp.withEvents` takes the `Mcp.toWebHandler` options that screen requests and serve events: `allowedOrigins`, `target`, `maximumBytes`, `services`, `heartbeatMs`, `eventBuffer`, `principal`, `poll` and `webhooks`. `mcp.dispose()` ends the poll leases and webhook subscriptions. It does not dispose your server.

#### Events in other bindings

- Command line: `watch <id>` follows an event. See [Command line](#command-line).
- WebMCP: WebMCP serves no events. The page follows them through the event handles.

### Services for each request

By default, a web handler builds the services from `layer` once, for the first request that passes screening, and every request shares them. With `services: "per-request"`, the handler builds them for each request that passes screening and releases them after the response. For a server-sent events stream, the session and services stay open until the stream ends. Use it when a request must not see objects that an earlier request made (on Cloudflare Workers, for example), or when callers must not share a stateful service:

```ts
const handler = Mcp.toWebHandler(app, makeLayer(env), { ...options, services: "per-request" });
```

With `services: "per-request"`, the layer can read the request head (method, URL and headers) from the `Remote.IncomingRequest` service. Use it to find the caller, for example from a bearer token; the capabilities then read the caller from the services. The types refuse `Remote.IncomingRequest` in a layer with shared services.

The layer can also refuse the request by failing with a `Remote.Refusal`. The handler then answers with the refusal's status and headers, `Content-Type: application/json`, and the body `{ "message": message }`. It opens no session, and no capability runs. `Remote.refuse(status, message, headers?)` fails with a `Remote.Refusal`, and throws a `RangeError` when the status is not an integer from 400 to 599. Put no internal data in the message.

```ts
class Caller extends Context.Service<Caller, { readonly name: string }>()("app/Caller") {}

const callerLayer = Layer.effect(
  Caller,
  Effect.gen(function* () {
    const request = yield* Remote.IncomingRequest;
    const name = request.headers.get("Authorization")?.match(/^Bearer (.+)$/)?.[1];
    if (name === undefined) return yield* Remote.refuse(401, "Give a token.", { "WWW-Authenticate": "Bearer" });
    return { name };
  }),
);

const handler = Http.toWebHandler(app, callerLayer, { allowedOrigins, services: "per-request" });
```

A poll lease or a webhook subscription keeps the services of the request that started it, including its caller. So set the MCP binding's `principal` option from the same caller. Leases are keyed by principal, event and input: with no principal, two callers that poll the same event with the same input share one lease, and the second caller reads occurrences from the first caller's session. `Mcp.withEvents` refuses only events extension requests. It passes the other requests to your own MCP server, which authenticates them itself.

`Mcp.handle(app, request, options)` and `Http.handle(app, request, options)` screen one request and answer it. A host that uses them builds the services itself, provides them to this Effect, and can give `Remote.IncomingRequest` the value `Remote.headOf(request)`. `Mcp.handle` keeps no state between requests, so it serves no poll leases and no webhook subscriptions. `Mcp.makeHandle(app, options)` keeps them in its scope (see [Poll delivery](#poll-delivery)).

### Command line

The command line has one command for each capability in the `cli` target's view. The id's words give the command's path. These rules apply:

- Each top-level input property is a flag with the same name, for example `--celsius 22` or `--celsius=22`.
- A boolean property is a switch, for example `--on`.
- A property that holds an array of strings, numbers or string enum values is a repeated flag. Each occurrence gives one item, in flag order. A repeated flag that occurs once can also give the whole array as JSON text.
- Other properties take JSON text.
- A shared prefix only groups other commands. If one capability's path is the start of another's, for example `aircon.status` and `aircon.status.get`, `Cli.command` throws, so the program stops with an error at startup.

For example, with the air conditioner's command line in [`examples/aircon/core-effect/cli.ts`](../../examples/aircon/core-effect/cli.ts):

```sh
node cli.ts aircon temperature set --celsius 22
node cli.ts aircon schedule set --days mon --days fri --hours 7 --hours 18   # {"days":["mon","fri"],"hours":[7,18]}
node cli.ts aircon schedule set --days '["mon","fri"]' --hours '[7,18]'      # the same input, as JSON text
node cli.ts aircon schedule set --days '[]'                                   # an empty array
node cli.ts list                                                             # the usage of each command
node cli.ts aircon power set --help                                          # Usage: aircon aircon power set --on, then the description
node cli.ts aircon status --help                                             # Commands:, then the usage of each command under aircon status
```

When the command line breaks a binding rule, for example two commands with the same path, `Cli.run` and `Cli.runCommand` die with the error. `NodeCli.main` and `NodeCli.runCommand` write the message to standard error and exit with code 5 (`internal`).

Help and `list`:

- `list` gives a usage line for each capability. A repeated flag's usage ends with `...`, for example `--days <mon|tue|wed|thu|fri|sat|sun>... [--hours <integer>...]`.
- Each `list` item has `kind`: `"capability"` or `"event"`. Event items come after capability items. Their `usage` ends with `[--cursor <string>] [--max-age-ms <integer>]`.
- `--help` after a command's path writes `Usage: ` and its usage, an empty line, and its description. `<alias> --help` and `watch <id> --help` do the same for an alias and an event.
- `--help` after a shared prefix writes `Commands:` and the usage of each command under it, in `list` order.
- A shared prefix alone, or with arguments that are neither `--help` nor a command's path, writes the same list to standard error, with exit code 2.
- This help replaces the `effect/cli` help for these commands. The root command, `call`, `list` and `watch` keep the `effect/cli` help.

See the [CLI binding](../../spec/bindings/cli.md#commands) for all the rules. Effect logs go to standard error, so standard output carries only the output.

#### Follow an event

`watch <id>` follows an event of the view. Its flags come from the event's input schema, with the same rules. When the input schema has no top-level `properties`, `watch <id> '<json>'` takes the input as JSON text. In the JSON form, each occurrence goes to standard output as one line of JSON as soon as it arrives:

```sh
node cli.ts watch aircon.status.changed | jq .data.celsius
```

`--cursor <string>` gives the cursor, and `--max-age-ms <integer>` gives `maxAgeMs`, in both forms. Each occurrence on standard output has its cursor, so a script can keep the last cursor and resume after it:

```sh
node cli.ts watch aircon.status.changed --cursor "$(tail -n 1 status.jsonl | jq -r .cursor)" --max-age-ms 600000 >> status.jsonl
```

These two flags are not input properties. If an event in the view has a top-level input property named `cursor` or `max-age-ms`, `Cli.command` throws at startup. A `--max-age-ms` that is not an integer, or is negative, exits with 3. A subscription that cannot start exits with its call failure's code.

| End | Standard error | Exit code |
| --- | --- | --- |
| Complete | Nothing | 0 |
| Cancelled (`SIGINT`) | Nothing | 130 |
| `internal` | `{ "kind", "message" }` | 5 |

In `NodeCli.main` and `NodeCli.runCommand`, `SIGINT` interrupts the fiber of the call or subscription. A fiber that cannot be interrupted, for example in an uninterruptible region, does not keep the process running: if the fiber has not ended one second (`INTERRUPT_GRACE_MS` from `@acid-cat/spec-ts`) after the interrupt, the process exits with 130 and writes nothing more. A second interrupt exits with 130 at once.

#### Aliases

The `cli` target can give [aliases](../../spec/bindings/cli.md#aliases) in its `cli` member: short names for capabilities and events, with an optional fixed input. A command alias is one or two words. A flag alias is `--` and one word. `App.alias` takes the capability or event; the fixed input's type is the encoded side of the input schema. `App.aliasDefault` also makes the alias the default. The catalog writes the aliases in `options.cli`:

```ts
targets: {
  cli: {
    bindings: ["cli"],
    cli: {
      aliases: {
        status: App.aliasDefault(statusGet),
        "--on": App.alias(powerSet, { on: true }),
        "--off": App.alias(powerSet, { on: false }),
        follow: App.alias(statusChanged),
        fan: App.alias(fanSet),
        "fan high": App.alias(fanSet, { speed: "high" }),
      },
    },
  },
},
```

```sh
node cli.ts --on      # the same call as: node cli.ts aircon power set --on
node cli.ts status    # the same call as: node cli.ts aircon status get
node cli.ts follow    # the same subscription as: node cli.ts watch aircon.status.changed
node cli.ts           # the default alias: node cli.ts status
node cli.ts fan high  # the same call as: node cli.ts aircon fan set --speed high
node cli.ts fan --speed low
```

- Fixed input properties are not flags of the alias. The other properties are flags, with the rules above.
- An event alias subscribes like `watch`, with the same exit codes, and also takes `--cursor` and `--max-age-ms`.
- `list` gives each capability's and event's alias usage in `aliases`, and the help lists them.
- Command aliases with the same first word form a group, such as `fan` and `fan high`. If the first two arguments name a two-word alias, that alias runs. Otherwise the one-word alias runs with the other arguments. A second argument that is a word but not the second word of an alias in the group, such as `node cli.ts fan medium`, is an unknown command with exit code 2.
- A command alias's name can be a shared prefix, but not a command's path. The alias is then that prefix's default: `"aircon power": App.alias(powerSet)` makes `node cli.ts aircon power --on` call `aircon.power.set`, while `node cli.ts aircon power set --on` stays the `aircon.power.set` command. A word after a prefix default that names no command, such as `node cli.ts aircon power nope`, is an unknown command with exit code 2.
- No application command may have a command alias's first word as its name.
- With no arguments, the program runs the default alias. If the first argument starts with `--` and is not `--help`, `--version`, a flag alias or a global flag, the program runs the default alias with all the arguments as its flags. `Cli.runCommand` stops with a defect at startup if a flag of the default alias has the name of an `effect/cli` or application global flag.
- If an alias breaks a rule, `Cli.command` throws at startup.

#### Output for a person

The command line writes JSON for programs. It can also write text for a person: the human form. The human form is off by default. Without the `output` option of `Cli.Options`, the command line writes only JSON, even on a terminal, and takes no output flag.

To turn on the human form, pass `output` (a `Cli.Output`):

- `flags` are the output flags. Each has `names`: `--word`, or `-x` with one letter or digit.
  - A switch has `form`: `"human"` or `"json"`, for example `{ names: ["--json"], form: "json" }`.
  - A flag with a value has `values`, a map from each value to a form, for example `{ names: ["--format", "-f"], values: { text: "human", json: "json" } }`. It takes `--format text`, `--format=text` and `-f text`.
  - An output flag can be anywhere in the arguments before a later `--`: `runCommand` removes it before `effect/cli` parses the rest. The command line ignores a leading `--`, which package runners such as `pnpm` and `npx` pass.
  - For an application command, the output flag must come before the command's name. The command gets the arguments after its name unchanged, and `Cli.outputForm` gives it the chosen form.
  - When the arguments give more than one output flag, the last wins. A missing or unknown value is a usage error with exit code 3: `The option --format must be json or text.`
- `default` is the form when no output flag is given: `"json"` (the default) or `"auto"`. With `"json"`, the output is JSON unless an output flag picks the human form. With `"auto"`, the form is human only when standard output is a terminal, `CI` is not set, and no coding agent variable is set (for example `CLAUDECODE` or `CODEX_THREAD_ID`). Otherwise it is JSON. A variable counts as set when its value is not empty, `0`, `false`, `no` or `off`. `Cli.formOf(stdoutIsTerminal, environment)` makes this decision. `Cli.run` and `Cli.runCommand` read the terminal and environment from the `Cli.Terminal` reference, whose default is no terminal, so tests get JSON. `NodeCli` gives the process's terminal and environment.
- `formats` are the human form's formatters (see below).

The root command's help lists the output flags under `OUTPUT FLAGS`. An output flag can be named `-h`: then `-h` picks its form, `--help` writes the help, and the help does not show `-h` for `--help`.

`Cli.command` throws at startup if an output flag's name is invalid, appears in two output flags, or is another flag's name: `--help`, `--version`, `--cursor`, `--max-age-ms`, a flag alias, or an input flag of a capability or event in the view. `runCommand` stops with a defect at startup if an output flag has the name of an `effect/cli` flag, such as `--log-level` or `--completions`, or of an application global flag.

In the human form:

- The text has color only when standard output is a terminal and `NO_COLOR` is not set.
- Each outcome's exit code and stream are the same as in the JSON form.
- A call failure goes to standard error as `error (<kind>): <message>`.
- `list` gives a table of the commands and events. `watch` writes one block for each occurrence.
- Help, `--version` and usage errors are the same as in the JSON form.

Without a formatter, the text is a generic layout of the value: an object gives one line for each member, an array of objects gives a table, and an array of scalars gives its items separated by commas. `Cli.layout(value)` gives this text.

`App.format` makes a formatter for a capability or an event, and `output.formats` takes them. A formatter gets its value in its schema's `Type` form: the command line first decodes the JSON with the output schema, a failure schema or the payload schema. A formatter also gets `ui`, with the styles `bold`, `dim`, `ok`, `warn` and `error`, and `table(header, rows)`. From [`examples/aircon/core-effect/output.ts`](../../examples/aircon/core-effect/output.ts):

```ts
const statusText = ({ power, mode, fan, targetCelsius, roomCelsius }: typeof Status.Type, ui: Cli.Ui) =>
  `${ui.bold(power ? "on" : "off")} · ${mode} · fan ${fan} · target ${targetCelsius}°C · room ${roomCelsius}°C`;

export const output: Cli.Output = {
  flags: [
    { names: ["--output", "-o"], values: { human: "human", json: "json" } },
    { names: ["--json"], form: "json" },
  ],
  formats: [
    App.format(statusGet, {
      value: statusText,
      failures: { Offline: ({ since }, ui) => `${ui.error("offline")}${since === undefined ? "" : ` since ${since}`}` },
    }),
    App.format(statusChanged, statusText),
  ],
};

NodeCli.main(aircon, layer, { name: "aircon", version: "0.1.0", output });
```

```sh
node cli.ts status --output human   # off · cool · fan auto · target 22°C · room 25°C
node cli.ts status --json           # {"power": false, "mode": "cool", …}
```

- `App.format(capability, { value, failures })` takes a formatter for the value and one for each failure tag. Each is optional.
- `App.format(capability, value)` takes only the value's formatter. `App.format(event, payload)` takes the payload's formatter.
- TypeScript checks the tags and the value types.
- A `null` value gives no output.
- When the value does not decode, or the formatter throws, the command line writes the generic layout, with the same exit code.
- If two formats have the same id, or a format's id is not in the target's view, `Cli.command` throws at startup.

#### Command line that calls a server

The command line can serve a view of an application that runs on a server (see [Server](../../spec/bindings/cli.md#server)). It is then a client of that application's HTTP binding. `Http.client(base, options)` makes the client, and the command line's `remote` option takes it:

```ts
import { Http } from "@acid-cat/core-effect";
import { NodeCli } from "@acid-cat/core-effect/node";

NodeCli.main(aircon, unitLayer, {
  name: "aircon",
  version: "0.1.0",
  remote: Http.client("http://pi.local:8080/cli", { headers: { Authorization: `Bearer ${token}` } }),
});
```

- The commands, flags and usage come from the view of `target` in the program. The program does not read the server's catalog.
- A call is `POST {base}/capabilities/{id}`. `list` gets availability from `GET {base}/capabilities`, and a capability that the server does not list is unavailable. `watch` is `POST {base}/events/{id}`, with the cursor in `Last-Event-ID` and `maxAgeMs` in the query.
- If the server does not answer, the call failure is `unavailable` (exit code 4). If the server gives an answer that the HTTP binding cannot give, the call failure is `internal` (exit code 5).
- `SIGINT` closes the request and exits with 130. The server then cancels the call or subscription.
- The client adds `headers` to each request. The command line never writes them to standard output or standard error.
- `Http.client` throws an `Error` when `base` is not an `http` or `https` URL, or when a header is invalid. The message does not contain any header value.
- The `layer` option of `Http.client` gives the `effect/http` client that sends the requests. The default is `FetchHttpClient.layer`, which uses `globalThis.fetch`. Pass another layer, for example to trust a server's certificate.
- The command line opens no session in its own process, but `NodeCli.main` still builds the services layer.

Serve the HTTP binding with the command line's target, so both have the same view:

```ts
const cli = Http.toWebHandler(aircon, unitLayer, { allowedOrigins: [], base: "/cli", target: "cli" });
yield* NodeServer.serve({ "/cli": cli }, { hostname: "0.0.0.0", port: 8080 });
```

[`examples/aircon/core-effect/serve.ts`](../../examples/aircon/core-effect/serve.ts) serves the air conditioner this way, and [`examples/aircon/core-effect/cli.ts`](../../examples/aircon/core-effect/cli.ts) calls it when `AIRCON_URL` is set. Other Effect code can also call a server with an `Http.Client`: `client.invoke(id, input)`, `client.capabilities` and `client.subscribe(id, input, resume)`.

#### Application flags

The CLI binding lets an application add its own flags. `Cli.command(app, options)` gives the command. Change it with `effect/cli`, then run it with `Cli.runCommand`, or `NodeCli.runCommand` from `@acid-cat/core-effect/node`. Both set the binding's exit codes. `Cli.exitCodeOf(error)` gives the exit code of one usage error.

```ts
import { Cli } from "@acid-cat/core-effect";
import { NodeCli } from "@acid-cat/core-effect/node";
import { Effect, Layer } from "effect";
import { Command, Flag, GlobalFlag } from "effect/cli";

const historyFile = GlobalFlag.Setting("history-file")({ flag: Flag.String("history-file") });

// The services depend on the flag.
const services = Layer.unwrap(Effect.map(historyFile, (path) => historyLayer(path)));

const command = Cli.command(app, { name: "aircon", version: "0.1.0" }).pipe(
  Command.provide(services),
  Command.withGlobalFlags([historyFile]),
);

NodeCli.runCommand(command, { version: "0.1.0" });
```

#### Application commands

The `commands` option adds application commands beside the capability commands, `call`, `list` and `watch`. Each one is an `effect/cli` command. `Cli.command` throws if its name is `call`, `list`, `watch`, another application command's name, or the first word of a capability's command. The `description` option gives the text at the top of the help. It defaults to the application's description, then its title, then the program name.

```ts
import { NodeCli } from "@acid-cat/core-effect/node";
import { Console, Effect, SubscriptionRef } from "effect";
import { Command } from "effect/cli";

const report = Command.make("report", {}, () =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.get(yield* Unit);
    yield* Console.log(`The room is at ${state.roomCelsius} °C.`);
  }),
).pipe(Command.withDescription("Write the temperature of the room."));

// The layer gives the services of the capabilities and of the commands of the application.
NodeCli.main(aircon, unitLayer, { name: "aircon", version: "0.1.0", description: "Control the air conditioner.", commands: [report] });
```

## Runtimes and bundles

`@acid-cat/core-effect` works in every runtime, including browsers. Only `@acid-cat/core-effect/node` and `@acid-cat/core-effect/NodeServer` need Node.js.

Each module also has its own entry point, for example `@acid-cat/core-effect/Session`. The package has no side effects, so a bundler keeps only the modules that a program imports, from either entry point. A web page that imports `Session`, `Handles` and `WebMcp` does not contain `Cli` or `Mcp`, or the `effect/cli` and `effect/ai` modules that they use.

## Examples and tests

- [`examples/aircon/core-effect`](../../examples/aircon/README.md) is an air conditioner written with this package, with its command line. [`examples/aircon/apis/mcp.ts`](../../examples/aircon/apis/mcp.ts) builds an MCP server with its own tools on it, beside the MCP binding.
- `moon run core-effect:test` tests sessions, handles and every binding with the package's test applications in [`test/`](test/), and runs `acid-cat conform` against every binding:
  - [`test/fixture.ts`](test/fixture.ts) has one capability for each behavior that `acid-cat conform` tests. [`test/fixture-cli.ts`](test/fixture-cli.ts) is its command line, and [`test/fixture-cli-remote.ts`](test/fixture-cli-remote.ts) is its command line that calls a server.
  - [`test/events-fixture.ts`](test/events-fixture.ts) has one event for each subscription behavior: filters, cursors, a defect, a payload that does not match, and an event outside the view. [`test/events-cli.ts`](test/events-cli.ts) is its command line.
  - [`test/lamp.ts`](test/lamp.ts) is a smart lamp with shared types, failures, a state and an availability. [`test/lamp-cli.ts`](test/lamp-cli.ts) is its command line. The tests use the lamp for the catalog, typed handles, state, availability, and the command line as a separate process.
