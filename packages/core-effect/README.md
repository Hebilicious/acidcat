# @acid-cat/core-effect

Serve AcidCat capabilities and events with [Effect](https://effect.website). npm package: `@acid-cat/core-effect`.

All of this package is Effect: a capability is an Effect program with Effect Schema types, an event is a `Stream`, a session is a scope, the services of the application are layers, and a cancellation is the interruption of a fiber. The application writes its own catalog.

```sh
pnpm add @acid-cat/core-effect effect
pnpm add @effect/platform-node  # only for NodeCli, from @acid-cat/core-effect/node
```

`effect` and `@effect/platform-node` are peer dependencies, so that the application and the core share one Effect. The package supports Effect 4.

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

- `input` is a `Schema.Struct`, or a `Schema.Union` of structs. The catalog writes a union with `"type": "object"`, so that it is an object schema. With no `input`, `run` gets the object that the client sent, as a `Capability.NoInput`. Use `Schema.Finite` or `Schema.Int` for numbers: `Schema.Number` also accepts `Infinity` and `NaN`, which JSON cannot hold.
- Each failure is a `Schema.TaggedStruct`. Its tag is the tag in the catalog.
- `availability` is an optional Effect that gives a `SubscriptionRef` of availability values. With no `availability`, the capability is always available.
- `state` is an optional `{ schema, value }`: the schema of the [state](../../spec/invocation.md#state), and an Effect that gives a `SubscriptionRef` of its values. Handles need a state schema that encodes synchronously, because `getSnapshot` is synchronous. `Handles.make` fails with an error that names the capability if the schema does not.
- `Capability.make` builds the `pipeline` of the capability: the calls that a session makes when it does not know the types of the schemas. Each part checks its values with the schemas of the same capability. Declare each capability with `Capability.make`.
- Give a shared type an `identifier` annotation. It becomes a named type in `$defs`.
- `Capability.make` keeps the literal type of `id`, so that an application can type its ids, for example `typeof powerSet.id`. The capability needs the services that `run`, `availability` and `state` need.

### Availability and state

A session gets the ref of each availability and each state one time, when it opens. It starts no fiber. It reads the availability ref when a call comes in, so a call that comes after `SubscriptionRef.set` is decided on the new value. `session.changes` and `session.state(id)` follow the refs only while they run, and a handle follows its refs only while it has listeners.

Make each ref in a layer, so that all sessions share it. If the source of an availability or a state is a `Stream`, follow the stream one time in that layer. Fork the follower with `startImmediately: true`, so that it subscribes to the source before the layer is built. A follower that starts later loses each change that the source gives before it subscribes, for example from a `PubSub`:

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

An [event](../../spec/events.md) is a thing that happens, that clients follow. `Event.make` declares it, and `subscribe` gives a `Stream` of the things that happen:

```ts
import { App, Event } from "@acid-cat/core-effect";
import { Schema, Stream } from "effect";

const Status = Schema.Struct({ power: Schema.Boolean, celsius: Schema.Int }).annotate({ identifier: "Status" });

export const statusChanged = Event.make({
  id: "aircon.status.changed",
  description: "The status of the unit changed. The occurrence gives the new status.",
  audience: ["app", "mcp"],
  input: Schema.Struct({}),
  payload: Status,
  subscribe: () => Unit.statusChanges.pipe(Stream.map((status) => ({ data: status }))),
});

export const aircon = App.make({ targets, capabilities: [powerSet], events: [statusChanged] });
```

- `input` is a `Schema.Struct`, with the rules of the input of a capability. `subscribe` gets the decoded input, and `resume`: the `cursor` and the `maxAgeMs` of the client (spec/events.md#resuming). With no cursor, start now.
- `payload` is a `Schema.Struct`, or another schema of an object. With no payload, the data of each occurrence is an empty object.
- Each value of the stream is an `Emitted`: `data`, and optionally `eventId`, `timestamp`, `cursor` and `truncated`. The session makes the `eventId` and the `timestamp` when the provider gives none. Give the `eventId` of the source when it has one.
- The stream has no error channel. Put the problems of the source in the payload, for example as a union with a `_tag`. A defect of the stream, or a payload that does not agree with the payload schema, ends the subscription with the call failure `internal`. Its details go to the log, not to the client.
- A subscription ends when the stream ends (complete), when the client cancels it (the fiber of the stream is interrupted), or when the session closes (complete). Release the resources of the source with `Stream.ensuring` or a scoped resource.
- The stream starts in a fiber of the session before `subscribe` returns, and runs until it first waits. Thus a stream that subscribes to a `PubSub` without waiting gets each value that is published after `subscribe` returns. A stream that waits before it subscribes, for example for an asynchronous effect, misses the values before it subscribes.
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
| `Session` | [Invocation](../../spec/invocation.md), [Events](../../spec/events.md) | `Session.make(app, { target })` gives a `Session<R>`, where `R` is the services of the application: `invoke` for untrusted input by id, typed calls (see [Typed calls](#typed-calls)), and subscriptions (see [Follow events](#follow-events)) |
| `Handles` | [TypeScript](../../spec/bindings/typescript.md) | `Handles.make(app, session)`: handles with promises and observables, for code that does not use Effect, such as a user interface. `Handles.makeEvents(app, session)`: event handles with async iterables. `Handles.open(app, layer, { target, webmcp })` opens a session from code that does not use Effect |
| `Mcp` | [MCP](../../spec/bindings/mcp.md) | Through HTTP: `Mcp.toWebHandler(app, layer, options)`, or `Mcp.makeHandle(app, options)` for a host that builds the services itself. `Mcp.withHandshake(handler)` also serves the [`initialize` handshake of earlier revisions](../../spec/bindings/mcp.md#earlier-revisions-through-http), from [`@acid-cat/mcp-handshake`](../mcp-handshake). Through stdio: `Mcp.serveStdio(app, options)`, and `NodeMcp.main(app, layer, options)` from `@acid-cat/core-effect/node` (see [MCP through stdio](#mcp-through-stdio)). Both on `effect/ai/McpServer` |
| `Http` | [HTTP](../../spec/bindings/http.md) | `Http.toWebHandler(app, layer, options)` |
| `Cli` | [CLI](../../spec/bindings/cli.md) | `Cli.run(app, options)`, on `effect/cli`. `NodeCli.main(app, layer, options)` from `@acid-cat/core-effect/node` runs it as the main program of a Node.js process |
| `WebMcp` | [WebMCP](../../spec/bindings/webmcp.md) | `WebMcp.install(session)`. WebMCP serves no events |
| `NodeServer` | MCP and HTTP | `NodeServer.serve(handler, options)` and `NodeServer.layer(handler, options)` serve web handlers on Node.js. See [Serve on Node.js](#serve-on-nodejs) |
| `NodeWebhook` | MCP | `NodeWebhook.sender(options)` sends the requests of webhook delivery from Node.js. See [Webhook delivery](#webhook-delivery) |

`layer` gives the services that the capabilities need. A web handler is `(request: Request) => Promise<Response>`. It works in Node, Bun, Deno and Cloudflare Workers. When the signal of a request aborts, the handler cancels the call of the request.

### Serve on Node.js

`NodeServer` serves web handlers on Node.js, with only `node:http`. It has no other dependency. The server runs in a scope.

```ts
import * as NodeServer from "@acid-cat/core-effect/NodeServer";
import { Effect, Layer } from "effect";

const mcp = Mcp.toWebHandler(aircon, unitLayer, mcpOptions);
const http = Http.toWebHandler(aircon, unitLayer, httpOptions);

Layer.launch(NodeServer.layer({ "/mcp": mcp, "/": http }, { port: 3000 })).pipe(Effect.runFork);
```

`NodeServer.serve(handler, options)` is an Effect that needs a `Scope`. It gives the `url` and the `port` of the server, and the server closes when the scope closes. `NodeServer.layer(handler, options)` serves while the layer is built. `Layer.launch` runs it until the program is interrupted. Both fail with `ServeError` when the server cannot listen, for example when the port is in use.

The handler is one handler for all paths, or handlers by path prefix. The longest prefix that matches gets the request, and the prefix `/` matches all paths. The MCP handler answers on all paths, so give it only its own prefix. A path that no prefix matches gets `404`. A handler that rejects gets `500`.

| Option | Default | Use |
| --- | --- | --- |
| `port` | `3000` | The port. With `0`, the system chooses a free port |
| `hostname` | `127.0.0.1` | The address. Only the same computer can connect. Use `0.0.0.0` or `::` to accept connections from the network |

When a client closes its connection, the signal of its request aborts, so the handler cancels the call or the subscription. The server sends the headers of a response with a body before the first chunk, so that the client of a stream of server-sent events gets the status before the first message. `@acid-cat/core-effect/NodeServer` needs only Node.js. `@acid-cat/core-effect/node` exports `NodeServer` too, with `NodeCli`, which needs `@effect/platform-node`.

`NodeServer` gives a plain HTTP/1.1 server. It does not serve HTTPS. When clients connect through a network, end TLS before the server, in the platform: a load balancer, the ingress of a Kubernetes cluster (for example with cert-manager for the certificates), or a tunnel such as Cloudflare Tunnel. The platform sends plain HTTP to the server on its private network. Set `hostname` to `0.0.0.0` or `::`, so that the platform can connect. Do not put a TLS proxy in the process in front of `NodeServer`.

For more, use a library for web handlers, for example [srvx](https://srvx.h3.dev): HTTPS in the process, when TLS must reach the server, HTTP/2, middleware, or the same server code on Bun and Deno. Give it the handler. Make sure that the library aborts the signal of a request when the client closes the connection. If it does not, a closed connection does not cancel the call.

### MCP through stdio

An MCP client, for example a coding agent, can start the server as a local process. `NodeMcp.main` serves the standard input and output of a Node.js process:

```ts
#!/usr/bin/env node
import { NodeMcp } from "@acid-cat/core-effect/node";

NodeMcp.main(aircon, unitLayer, { name: "aircon", version: "1.0.0" });
```

- The process is one session. The server serves revision `2026-07-28`, and the `initialize` handshake of revisions `2025-11-25` and `2025-06-18`.
- When the availability of a capability changes, the server sends `notifications/tools/list_changed`. `notifications/cancelled` interrupts the call.
- `Mcp.serveStdio(app, options)` is the server on the `Stdio` service of `effect`, for any runtime. It completes when standard input ends. Then the session closes, and the calls in progress are interrupted. `Mcp.layerStdio(app, options)` is the same server as a layer, which serves while its scope is open.
- Standard output carries only MCP messages, so the server sends the logs of Effect to standard error. Do not write to standard output from a capability.
- When the view has events, the server serves the events extension to clients of revision `2026-07-28` (see [Follow events](#follow-events)), with push and poll delivery. `notifications/cancelled` with the id of an `events/stream` request cancels that subscription. The option `poll` sets the poll leases (see [Poll delivery](#poll-delivery)). The process has no principal. Webhook delivery is only through HTTP, so `events/subscribe` and `events/unsubscribe` answer with `Unsupported`.

### Typed calls

A typed call takes the capability object, and has the types of its schemas. Only the capability object that the session serves can be called. Any other object, also one with the same id, is `unknown-capability`. The capability needs only services of the application.

| Effect `Session` | Input | Result |
| --- | --- | --- |
| `session.call(capability, input)` | not trusted: the input schema of the capability decodes it | `Effect<Value, Failure \| CallFailed>`. An input that does not decode is the call failure `invalid-input` |
| `session.execute(capability, input)` | already decoded, with the type of the input | `Effect<Value, Failure \| CallFailed>` |
| `session.outcome(capability, input)` | already decoded, with the type of the input | `Effect<Outcome<Value, Failure>>`, which never fails |

```ts
import { Session } from "@acid-cat/core-effect";

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* Session.make(aircon, { target: "mcp" });
    return yield* session.call(powerSet, { on: true }); // Effect<null, typeof Offline.Type | Session.CallFailed>
  }),
);
```

`Handles.open` gives a session for code that does not use Effect, with the same names:

- `session.call(capability, input)` decodes an input that is not trusted, and gives `Promise<Result<Value, Failure>>`. A call failure rejects with a `CallFailureError`: an input that does not decode as `invalid-input`.
- `session.handle(capability)` gives the handle of a capability with the types of its schemas: `execute` takes the decoded input, and gives the decoded value or failure. `snapshot` gives the state in its JSON form. For a capability that the session does not serve, the handle is always unavailable, and each call rejects as `unknown-capability`.
- `await using session = await Handles.open(…)` closes the session at the end of the block. `session.dispose()` closes it too.
- `session.handles` gives the handles by id, without the types of the schemas, for bindings.

```ts
import { Handles } from "@acid-cat/core-effect";

await using session = await Handles.open(aircon, unitLayer, { target: "app" });
const result = await session.call(powerSet, request.body); // Result<null, typeof Offline.Type>
const power = session.handle(powerSet); // Handles.HandleOf<typeof powerSet>
await power.execute({ on: true }); // Result<null, typeof Offline.Type>
```

With the option `webmcp`, a WebMCP host, the session also registers its tools on that host. The tools close with the session. Without the option, `session.webmcp` is `undefined`. To use the host of the page, give `webmcp: WebMcp.findHost()`.

- `session.webmcp.status` observes the status of the tools.
- `session.webmcp.retry()` asks for the last failed update again. Its promise resolves when the request is queued, not when the update ends. Watch `status` for the outcome.
- `session.webmcp.remove()` removes the tools from the host while the session stays open. The session then registers no more tools, and `retry()` does nothing. The promise resolves when the tools are removed. The calls in progress continue, and the handles and the services stay open, so a capability can call `remove()` during its own call. `status` is `closing` until the WebMCP calls in progress end, then `disposed`. A second `remove()` does nothing more, and `dispose()` works after it. `WebMcp.install` gives the same operation as the effect `remove` of the installation.

```ts
import { Handles, WebMcp } from "@acid-cat/core-effect";

await using session = await Handles.open(aircon, unitLayer, { target: "app", webmcp: WebMcp.findHost() });
session.webmcp?.status.subscribe((status) => render(status.phase));
```

### Follow events

A subscription starts, or fails with a call failure before the first occurrence: `cancelled` when the session is closing, `unknown-capability` when the event is not in the view, and `invalid-input` when the input does not agree with the input schema, or `maxAgeMs` is not an integer that is 0 or more. Each binding follows the [events](../../spec/events.md) of the specification, and of its own document.

| Effect `Session` | Input | Result |
| --- | --- | --- |
| `session.subscribe(id, input, { cursor, maxAgeMs })` | not trusted: the input schema decodes it | `Effect<Subscription<unknown>, CallFailed, Scope>`. Each `data` is in its JSON form. An input that does not decode, or a `maxAgeMs` that is not an integer that is 0 or more, is the call failure `invalid-input` |
| `session.follow(event, input, { cursor, maxAgeMs })` | already decoded, with the type of the input | `Effect<Subscription<Payload>, CallFailed, Scope>`. Each `data` is a copy, with the type of the payload. A `maxAgeMs` that is not an integer that is 0 or more is the call failure `invalid-input` |

A `Subscription<Payload>` is a `Stream<Occurrence<Payload>, CallFailed>`. The scope is the lifetime of the subscription: when it closes, the subscription is cancelled. Interrupt the stream to cancel it too. The stream ends when the provider has no more occurrences, or when the session closes. It fails with `internal` when the provider fails. Only the event object that the session serves can be followed.

```ts
const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* Session.make(aircon, { target: "app" });
    const changes = yield* session.follow(statusChanged, {}); // Stream<Occurrence<typeof Status.Type>, CallFailed>
    yield* Stream.runForEach(changes, (occurrence) => Console.log(occurrence.data.celsius));
  }),
);
```

The session keeps the occurrences that the client has not read, up to `eventBuffer` for each subscription (the option of `Session.make`, `Handles.open` and the web handlers, 1024 by default). When the limit is full, it removes the oldest occurrence, and the next occurrence that the client reads has `truncated: true`.

**Handles.** `session.events` of `Handles.open` gives the event handles by id, and `session.event(event)` gives the handle of an event with the types of its schemas. `subscribe(input, options)` gives `Promise<AsyncIterable<Occurrence<Payload>>>`, and `subscribeExternal(input, options)` validates an input that is not trusted. The promise resolves when the subscription has started, and rejects with a `CallFailureError` when it cannot start. `return()` of the iterator cancels the subscription, also while a `next()` waits: that `next()` resolves with `done: true`. `options.signal`, and the end of the session, cancel it too. When the provider fails, `next()` rejects with an error whose `kind` is `internal`, then resolves with `done: true`. A GraphQL server can return the promise from the `subscribe` resolver of a field, for subscriptions through WebSockets (graphql-ws) or server-sent events (GraphQL Yoga, graphql-sse):

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

**HTTP.** `GET {base}/events` lists the events of the view. `POST {base}/events/{id}` with the input as the body gives a stream of server-sent events: `event: next` for each occurrence, with the cursor as `id:`, then `event: complete`, or `event: error` with the call failure `internal`. A call failure before the stream is a JSON answer with its status. The `Last-Event-ID` header gives the cursor, and the query parameter `maxAgeMs` gives `maxAgeMs`. When nothing goes on the stream for `keepaliveMs` (15 000 by default), the binding sends a comment line. When the client closes the stream, the subscription is cancelled.

**MCP.** When the view has events, the server serves the events extension, `io.modelcontextprotocol/events`, to clients of revision `2026-07-28`: `server/discover` declares it, and `events/list` lists the events, each with its delivery modes. A client of the `initialize` handshake gets no events. The server of `effect/ai` has no way to add methods, so the binding answers the requests of the extension before they reach that server.

- **Push.** `events/stream` subscribes. The messages of a subscription are `notifications/events/active`, `notifications/events/event` for each occurrence, `notifications/events/heartbeat` when nothing goes on the stream for `heartbeatMs` (15 000 by default), `notifications/events/terminated` for `internal`, and the result of `events/stream` at the end. Through HTTP, the answer to `events/stream` is a stream of server-sent events, and closing the request cancels the subscription. Through stdio, the messages go to standard output, and `notifications/cancelled` cancels the subscription.
- **Poll.** `events/poll` reads a poll lease, through HTTP and stdio. See [Poll delivery](#poll-delivery).
- **Webhook.** `events/subscribe` sends the occurrences to a URL of the client, only through HTTP, and only when the option `webhooks` is set. See [Webhook delivery](#webhook-delivery).

#### Poll delivery

A poll lease holds one subscription, in a session of its own, and a buffer of its occurrences. The key of a lease is the principal, the id and the input. Two polls with the same key read the same lease. The first poll with no cursor starts the lease, and gives no occurrences and a cursor. Each next poll gives the occurrences after its cursor, and a new cursor. The cursor tells the lease, the position in its buffer, and the last cursor of the provider. When the lease ended, a poll with its cursor starts a new lease, which resumes after that cursor of the provider, with `maxAgeMs`. See [Poll](../../spec/bindings/mcp.md#poll) for all the rules.

| Option of `poll` | Default | Use |
| --- | --- | --- |
| `leaseMs` | `300000` | A lease that gets no poll for this time ends, and its subscription is cancelled |
| `bufferLimit` | `1000` | The number of occurrences that a lease keeps. When the buffer is full, the lease removes the oldest one, and a poll with an older cursor gets `truncated: true` |
| `maxEvents` | `100` | The number of occurrences in a result when the request has no `maxEvents`. With more, the result has `hasMore: true` |
| `nextPollMs` | `2000` | The `nextPollMs` of each result |

The option `principal` of `Mcp.toWebHandler` gives the identity of the client of each request: `(request: Request) => Effect<Option<string>>`. Check the credentials of the request in it, for example a bearer token. A lease belongs to the principal of the request that started it, so a client cannot read the lease of another principal. With no principal, all clients with the same id and input read the same lease.

The leases live in the memory of the process. A lease opens its session with the services of the request that started it. With `services: "per-request"`, these services stay open until the lease ends. `handler.dispose()` of `Mcp.toWebHandler` ends all the leases and the webhook subscriptions, and releases the shared services. `Mcp.makeHandle(app, options)` gives a function that answers each request, as `Mcp.handle`, and keeps the leases and the webhook subscriptions in its scope. `Mcp.handle` keeps no state between requests, so it delivers only with push: `events/poll` and the webhook methods answer with `Unsupported`. Through stdio, the leases live while the server runs. A server that restarts loses its leases. Clients poll again with their cursors.

#### Webhook delivery

With the option `webhooks`, the server sends each occurrence in an HTTP `POST` request to a URL of the client, signed with the [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) scheme. Webhook delivery is off by default. It is only through HTTP. It needs the option `principal`: a request with no principal gets `Forbidden`.

```ts
import * as NodeWebhook from "@acid-cat/core-effect/NodeWebhook";

const mcp = Mcp.toWebHandler(aircon, unitLayer, {
  ...mcpOptions,
  principal: (request) => verifyBearerToken(request), // Effect<Option<string>>
  webhooks: { sender: NodeWebhook.sender() },
});
```

- **Subscribe.** `events/subscribe` with `delivery: { mode: "webhook", url, secret }` starts a subscription in a session of its own, or renews the subscription with the same principal, URL, id and input. The URL must use `https`. The secret must be `whsec_` and the base64 of 24 to 64 bytes. The server grants `ttlMs` between `minTtlMs` and `maxTtlMs`. A renewal grants a new lifetime and replaces the secret. For `rotationGraceMs`, the server signs with the old and the new secret. A subscription that gets no renewal before `refreshBefore` ends. `events/unsubscribe` ends a subscription at once.
- **Verification.** Before the first subscription of a principal to a URL, the server sends `{ "type": "verification", "challenge" }`. The endpoint agrees when it answers with a `2xx` status and `{ "challenge" }` with the same text. If not, `events/subscribe` fails with `CallbackEndpointError` (`-32027`), with `data.reason`. The server keeps each verification while the process runs. A URL for which `allow` gives `true` needs no verification.
- **Delivery.** The server sends the occurrences of one subscription one at a time, in order. The body is the occurrence, with the watermark as its `cursor`: the cursor of the last occurrence whose delivery succeeded or was abandoned. `{ "type": "gap", "cursor" }` comes before an occurrence with `truncated: true`, and `{ "type": "terminated", "error" }` ends a subscription that fails with `internal`. Each request has the headers `webhook-id`, `webhook-timestamp`, `webhook-signature` and `X-MCP-Subscription-Id`. After a status that is not `2xx`, the server sends the request again, with the same `webhook-id`, up to `attempts` times in `retryWindowMs`. `410` and `413` abandon the delivery at once. The result of each `events/subscribe` has `deliveryStatus`, with `lastDeliveryAt` and the category of the last failure in `lastError`.

| Option of `webhooks` | Default | Use |
| --- | --- | --- |
| `sender` | Required | Sends the requests. `NodeWebhook.sender(options)` for Node.js. A sender for another runtime is a function `(request) => Effect<WebhookResponse, WebhookSendError>` that follows the same network rules |
| `allow` | None | `(url: URL) => boolean`. The URLs that need no verification |
| `maxTtlMs` | `3600000` | The maximum lifetime of a subscription |
| `minTtlMs` | `60000` | The minimum lifetime of a subscription |
| `maxSubscriptions` | `100` | The maximum number of subscriptions of one principal. A new subscription over it gets `ResourceExhausted` (`-32025`) |
| `attempts` | `5` | The maximum number of attempts of one delivery |
| `retryWindowMs` | `900000` | The time after the first attempt of a delivery after which the server makes no more attempts |
| `retryDelays` | 5 s, then 4 times longer each time | A `Schedule` of the waits between the attempts |
| `timeoutMs` | `5000` | The time that the server waits for each answer |
| `rotationGraceMs` | `300000` | The time after a change of the secret during which the server signs with both secrets |

**Network safety.** A webhook URL comes from the client, so a request to it can reach the private network of the server. `NodeWebhook.sender` resolves the host name of the URL for each request, and connects only to an address that is globally routable. It connects to the address that it checked, with the host name in the `Host` header and in TLS, so that a second answer of the DNS cannot change the address. It does not follow redirects. It reads at most `maxResponseBytes` of each answer (65 536 by default).

| Option of `NodeWebhook.sender` | Default | Use |
| --- | --- | --- |
| `allowPrivateNetworks` | `false` | Connect also to loopback, private, link-local and other addresses that are not globally routable. Use it only for tests, or when all the endpoints are in a network that you control |
| `ca` | None | Certificate authorities in PEM that the sender trusts in addition to those of Node.js, for example the certificate authority of a test endpoint |
| `maxResponseBytes` | `65536` | The maximum number of bytes of an answer that the sender reads |

Keep the principal of each client separate: the key of a subscription and each verification include it, so a client cannot renew, read the secret of, or end the subscription of another principal. The subscriptions, the verifications and the counts for the limit live in the memory of the process. A server that restarts loses them. Clients subscribe again with their last cursor.

#### Events beside an MCP server of your own

An MCP server whose tools you design, written with `effect/ai/McpServer`, can serve the events of the application too. `Mcp.withEvents(app, layer, server, options)` wraps the web handler of your server. It screens each request as `Mcp.toWebHandler` does. It answers each request of the events extension of revision `2026-07-28` itself, with push, poll and, with the option `webhooks`, webhook delivery. It gives each other request to your server. Give your server `Mcp.eventsExtensions` as its `extensions`, so that `server/discover` declares the extension.

```ts
const server = McpServer.toolkit(MyTools).pipe(
  Layer.provide(handlers),
  Layer.provideMerge(McpServer.layerHttp({ name: "aircon", version: "0.1.0", path: "/mcp", protocols: [McpProtocol.v2026_07_28], extensions: Mcp.eventsExtensions })),
  Layer.provide(unit),
);
const application = HttpRouter.toWebHandler(server);
const mcp = Mcp.withEvents(aircon, unit, application.handler, { allowedOrigins: [] });
```

The options of `Mcp.withEvents` are the options of `Mcp.toWebHandler` that screen a request and serve events: `allowedOrigins`, `target`, `maximumBytes`, `services`, `heartbeatMs`, `eventBuffer`, `principal`, `poll` and `webhooks`. `mcp.dispose()` ends the poll leases and the webhook subscriptions. It does not dispose your server.

**Command line.** `watch <id>` follows an event. See [Command line](#command-line).

**WebMCP.** WebMCP serves no events. The page follows them through the event handles.

### Services for each request

By default, a web handler builds the services from `layer` once, for the first request that passes the screening, and all requests use them. With the option `services: "per-request"`, the handler builds them for each request that passes the screening, and releases them after the response. For a stream of server-sent events, the session and the services stay open until the stream ends. Use it when a request must not use objects that an earlier request made, for example on Cloudflare Workers, or when a stateful service must not be shared between callers:

```ts
const handler = Mcp.toWebHandler(app, makeLayer(env), { ...options, services: "per-request" });
```

`Mcp.handle(app, request, options)` and `Http.handle(app, request, options)` screen one request and answer it. A host that builds the services itself provides them to this Effect. `Mcp.handle` keeps no state between requests, so it serves no poll leases and no webhook subscriptions. `Mcp.makeHandle(app, options)` keeps them in its scope (see [Poll delivery](#poll-delivery)).

### Command line

The command line has one command for each capability in the view of the `cli` target. The words of the id give the path of the command. A shared prefix only contains other commands: if the path of a capability is the start of the path of another capability, for example `aircon.status` and `aircon.status.get`, `Cli.command` throws, so the program stops with an error when it starts. Each top-level property of the input is a flag with the same name, for example `--celsius 22` or `--celsius=22`. A boolean property is a switch, for example `--on`. A property with an array of strings, numbers or values of a string enum is a repeated flag: each occurrence gives one item, in the order of the flags. A repeated flag that occurs once can also give the whole array as JSON text. Other properties take JSON text. For example, with the command line of the air conditioner, [`examples/aircon/core-effect/cli.ts`](../../examples/aircon/core-effect/cli.ts):

```sh
node cli.ts aircon temperature set --celsius 22
node cli.ts aircon schedule set --days mon --days fri --hours 7 --hours 18   # {"days":["mon","fri"],"hours":[7,18]}
node cli.ts aircon schedule set --days '["mon","fri"]' --hours '[7,18]'      # the same input, as JSON text
node cli.ts aircon schedule set --days '[]'                                   # an empty array
node cli.ts list                                                             # the usage of each command
```

`list` gives a usage line for each capability. The usage of a repeated flag ends with `...`, for example `--days <mon|tue|wed|thu|fri|sat|sun>... [--hours <integer>...]`. See the [CLI binding](../../spec/bindings/cli.md#commands) for all the rules.

`watch <id>` follows an event of the view. The flags come from the input schema of the event, with the same rules. When the input schema has no top-level `properties`, `watch <id> '<json>'` takes the input as JSON text. Each occurrence goes to standard output as one line of JSON, as soon as it comes:

```sh
node cli.ts watch aircon.status.changed | jq .data.celsius
```

`--cursor <string>` gives the cursor, and `--max-age-ms <integer>` gives `maxAgeMs`, in both forms. Each occurrence on standard output has its cursor, so a script can keep the last cursor, and resume after it:

```sh
node cli.ts watch aircon.status.changed --cursor "$(tail -n 1 status.jsonl | jq -r .cursor)" --max-age-ms 600000 >> status.jsonl
```

These two flags are not properties of the input. If the input schema of an event in the view has a top-level property `cursor` or `max-age-ms`, `Cli.command` throws, so the program stops with an error when it starts. A `--max-age-ms` that is not an integer, or that is negative, exits with 3.

| End | Standard error | Exit code |
| --- | --- | --- |
| Complete | Nothing | 0 |
| Cancelled (`SIGINT`) | Nothing | 130 |
| `internal` | `{ "kind", "message" }` | 5 |

A subscription that cannot start has the exit code of its call failure. Each item of `list` has `kind`: `"capability"` or `"event"`. The items of the events come after the items of the capabilities, with their `usage`, which ends with `[--cursor <string>] [--max-age-ms <integer>]`. Standard output carries only JSON, so the logs of Effect go to standard error.

### Flags of the application

The CLI binding allows an application to add its own flags. `Cli.command(app, options)` gives the command. Change it with `effect/cli`, then run it with `Cli.runCommand`, or with `NodeCli.runCommand` from `@acid-cat/core-effect/node`. Both set the exit codes of the binding. `Cli.exitCodeOf(error)` gives the exit code of one usage error.

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

### Commands of the application

The option `commands` adds commands of the application beside the commands of the capabilities, `call`, `list` and `watch`. Each one is an `effect/cli` command. Its name must not be `call`, `list`, `watch`, the name of another command of the application, or the first word of the command of a capability. If it is, `Cli.command` throws. The option `description` gives the text at the top of the help. The default is the description of the application, then its title, then the name of the program.

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

`@acid-cat/core-effect` works in all runtimes, including browsers. Only `@acid-cat/core-effect/node` and `@acid-cat/core-effect/NodeServer` need Node.js.

Each module also has its own entry point, for example `@acid-cat/core-effect/Session`. The package has no side effects, so a bundler keeps only the modules that a program imports, from either entry point. A web page that imports `Session`, `Handles` and `WebMcp` does not contain `Cli` or `Mcp`, or the `effect/cli` and `effect/ai` modules that they use.

## Examples and tests

- [`examples/aircon/core-effect`](../../examples/aircon/README.md) is an air conditioner written with this package, with its command line. [`examples/aircon/apis/mcp.ts`](../../examples/aircon/apis/mcp.ts) builds an MCP server with its own tools on it, beside the MCP binding.
- `moon run core-effect:test` tests sessions, handles and all bindings with the test applications of the package, in [`test/`](test/), and runs `acid-cat conform` against all bindings:
  - [`test/fixture.ts`](test/fixture.ts) has one capability for each behavior that `acid-cat conform` tests.
  - [`test/events-fixture.ts`](test/events-fixture.ts) has one event for each behavior of subscriptions: filters, cursors, a defect, a payload that does not agree, and an event outside the view. [`test/events-cli.ts`](test/events-cli.ts) is its command line.
  - [`test/lamp.ts`](test/lamp.ts) is a smart lamp with shared types, failures, a state and an availability. [`test/lamp-cli.ts`](test/lamp-cli.ts) is its command line. The tests use the lamp for the catalog, typed handles, state, availability, and the command line as a separate process.
