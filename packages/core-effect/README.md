# @acid-cat/core-effect

An AcidCat core for [Effect](https://effect.website) users. You declare capabilities and events in TypeScript, the package writes the catalog from them, and serves them through every surface: TypeScript handles, MCP, HTTP, CLI and WebMCP.

A capability is an Effect program with Effect Schema types, an event is a `Stream`, a session is a scope, services are layers, and a cancellation interrupts a fiber. Without Effect, use [`@acid-cat/core-ts`](../core-ts). This package is one implementation of the [specification](../../spec/README.md); every core has the same features and passes `acid-cat conform`.

```sh
pnpm add @acid-cat/core-effect effect
pnpm add @effect/platform-node  # only for NodeCli and NodeMcp, from @acid-cat/core-effect/node
```

`effect` (version 4) and `@effect/platform-node` are peer dependencies, so the application and the core share one Effect.

## Quick start

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
  targets: { cli: { surfaces: ["cli"] } },
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

To serve the same capability through MCP or HTTP, add a target with that surface and use a module from [Serve the capabilities](#serve-the-capabilities).

## Write capabilities

```ts
import { App, Capability } from "@acid-cat/core-effect";
import { Effect, Schema } from "effect";

const Offline = Schema.TaggedStruct("Offline", {});

export const aircon = App.make({
  title: "Living-room air conditioner",
  targets: { cli: { surfaces: ["cli"] }, mcp: { surfaces: ["mcp"] } },
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

`Capability.make` options:

- `input`: a `Schema.Struct`, or a `Schema.Union` of structs (written as an object schema). With no `input`, `run` gets the raw object as a `Capability.NoInput`.
- For numbers, use `Schema.Finite` or `Schema.Int`. `Schema.Number` accepts `Infinity` and `NaN`, which JSON cannot hold.
- `failures`: `Schema.TaggedStruct`s. The tag is the catalog's failure tag.
- `readOnly`, `destructive`, `idempotent`: optional [hints](../../spec/catalog.md#capabilities).
- `availability`: an optional Effect that gives a `SubscriptionRef` of availability values. Without it, the capability is always available.
- `state`: an optional `{ schema, value }`, the [state](../../spec/invocation.md#state) schema and an Effect that gives a `SubscriptionRef`. The schema must encode synchronously, because a handle's `getSnapshot` is synchronous; otherwise `Handles.make` fails and names the capability.
- An `identifier` annotation on a shared type makes it a named type in `$defs`.

The result keeps the literal type of `id` (`typeof powerSet.id`), and requires the services that `run`, `availability` and `state` need.

### Read the session's target

`yield* Session.Target` gives the session's [target](../../spec/invocation.md#sessions) inside a capability, availability, state or event provider. The session provides it; outside a session it is the empty string.

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

A session gets each ref once, when it opens, and starts no fiber. It reads availability on each call, so a call after `SubscriptionRef.set` sees the new value. `session.changes` and `session.state(id)` follow the refs only while they run; a handle follows them only while it has listeners.

Make each ref in a layer so all sessions share it. If the source is a `Stream`, fork its follower in that layer with `startImmediately: true`, so it subscribes before the layer is built and misses nothing (for example from a `PubSub`):

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

`Event.make` declares an [event](../../spec/events.md). Its `subscribe` gives a `Stream` of occurrences:

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

- `input`: a `Schema.Struct`, as for capabilities. `subscribe` gets the decoded input and `resume` (the client's `cursor` and `maxAgeMs`, see [Resuming](../../spec/events.md#resuming)).
- `payload`: an object schema. With none, each occurrence's data is `{}`.
- Each stream value is an `Emitted`: `data`, and optionally `eventId`, `timestamp`, `cursor` and `truncated`. Pass the source's `eventId` when it has one; the session fills in the rest.
- The stream has no error channel. Put source problems in the payload (for example a union with a `_tag`). A defect or a payload that does not match ends the subscription with `internal`; details go to the log.
- Release resources with `Stream.ensuring` or a scoped resource. The stream ends on completion, cancellation (fiber interrupted) or session close ([Ending](../../spec/events.md#ending)).
- The stream starts in a session fiber before `subscribe` returns and runs until it first waits. A stream that subscribes to a `PubSub` without waiting gets every value published after `subscribe` returns; one that waits first can miss values.
- Capabilities and events share one id space. `App.document` throws on a duplicate id or a non-object payload.

## Write the catalog

```ts
import { writeFile } from "node:fs/promises";
import { App } from "@acid-cat/core-effect";

await writeFile("acidcat.catalog.json", App.render(aircon)); // canonical form
```

## Serve the capabilities

| Module | Surface | Entry point |
| --- | --- | --- |
| `Session` | [Invocation](../../spec/invocation.md), [Events](../../spec/events.md) | `Session.make(app, { target })` gives a `Session<R>`, where `R` is the application's services. It has `invoke` for untrusted input by id, [typed calls](#typed-calls) and [subscriptions](#follow-events) |
| `Handles` | [TypeScript](../../spec/surfaces/typescript.md), which maps the [programmatic surface](../../spec/surfaces/programmatic.md) | For code that does not use Effect, such as a user interface. `Handles.make(app, session)` gives handles with promises and observables. `Handles.makeEvents(app, session)` gives event handles with async iterables. `Handles.open(app, layer, { target, webmcp })` opens a session (see [Handles](#handles-for-code-without-effect)) |
| `Mcp` | [MCP](../../spec/surfaces/mcp.md) | Through HTTP: `Mcp.toWebHandler(app, layer, options)`, or `Mcp.makeHandle(app, options)` for a host that builds the services itself. `Mcp.withHandshake(handler)` also serves the [`initialize` handshake of earlier revisions](../../spec/surfaces/mcp.md#earlier-revisions-through-http), from [`@acid-cat/mcp-handshake`](../mcp-handshake). Through stdio: `Mcp.serveStdio(app, options)`, and `NodeMcp.main(app, layer, options)` from `@acid-cat/core-effect/node` (see [MCP through stdio](#mcp-through-stdio)). Both run on `effect/ai/McpServer` |
| `Http` | [HTTP](../../spec/surfaces/http.md) | `Http.toWebHandler(app, layer, options)`. `Http.client(base, options)` is a client of the surface, for a [command line that calls a server](#command-line-that-calls-a-server) |
| `Remote` | [Remote surfaces](../../spec/surfaces/README.md#remote-surfaces) | `Remote.IncomingRequest` (the request head, for per-request services) and `Remote.refuse(status, message, headers)`. See [Services for each request](#services-for-each-request) |
| `Cli` | [CLI](../../spec/surfaces/cli.md) | `Cli.run(app, options)`, on `effect/cli`. `NodeCli.main(app, layer, options, args?)` from `@acid-cat/core-effect/node` runs it as a Node.js process's main program. `args` defaults to `process.argv.slice(2)` |
| `WebMcp` | [WebMCP](../../spec/surfaces/webmcp.md) | `WebMcp.install(session)`. WebMCP serves no events |
| `NodeServer` | MCP and HTTP | `NodeServer.serve(handler, options)` and `NodeServer.layer(handler, options)` serve web handlers on Node.js. See [Serve on Node.js](#serve-on-nodejs) |
| `NodeWebhook` | MCP | `NodeWebhook.sender(options)` sends webhook delivery requests from Node.js. See [Webhook delivery](#webhook-delivery) |

`layer` gives the capabilities' services. A web handler is `(request: Request) => Promise<Response>` and runs on Node, Bun, Deno and Cloudflare Workers. An aborted request signal cancels that request's call.

### Serve on Node.js

`NodeServer` serves web handlers with `node:http` only.

```ts
import * as NodeServer from "@acid-cat/core-effect/NodeServer";
import { Effect, Layer } from "effect";

const mcp = Mcp.toWebHandler(aircon, unitLayer, mcpOptions);
const http = Http.toWebHandler(aircon, unitLayer, httpOptions);

Layer.launch(NodeServer.layer({ "/mcp": mcp, "/": http }, { port: 3000 })).pipe(Effect.runFork);
```

- `NodeServer.serve(handler, options)` needs a `Scope`, gives `url` and `port`, and closes with the scope. `NodeServer.layer` serves while the layer is built; `Layer.launch` runs it until interrupted.
- Both fail with `ServeError` when the server cannot listen.
- `handler` is one handler, or handlers by path prefix. The longest prefix wins and `/` matches everything. Give the MCP handler its own prefix, because it answers on all paths. No match gives `404`; a rejected handler gives `500`.
- A closed client connection aborts the request signal. Response headers go out before the first body chunk, so a server-sent events client sees the status early.

| Option | Default | Use |
| --- | --- | --- |
| `port` | `3000` | The port. With `0`, the system picks a free port |
| `hostname` | `127.0.0.1` | The address. The default accepts connections only from the same computer. Use `0.0.0.0` or `::` to accept connections from the network |

`@acid-cat/core-effect/NodeServer` needs only Node.js. `@acid-cat/core-effect/node` also exports it, with `NodeWebhook`, `NodeCli` and `NodeMcp` (these last two need `@effect/platform-node`).

`NodeServer` is plain HTTP/1.1. It closes no idle connection and sends no `Keep-Alive` header, as hyper and Go's `net/http` do by default. The client or the proxy in front closes an idle connection. A client that sends a request on an idle connection at the moment when the server closes it gets `ECONNRESET`. Undici (the `fetch` of Node.js) keeps an idle connection for the `Keep-Alive` time of the server less 2 s, and proxies keep one for 60 s (AWS load balancers, nginx) to 90 s (Cloudflare Tunnel) or more, so every idle timeout of the server leaves this race open. When the scope closes, the server stops accepting connections, ends each idle connection at once, and ends each other connection when both its request and its response are complete, so it cuts no request that the server accepted. The close of the scope ends when every connection has ended, so a response that does not end, such as an open event stream, keeps it waiting. For network clients, end TLS in front of it (a load balancer, a Kubernetes ingress, Cloudflare Tunnel) and set `hostname` to `0.0.0.0` or `::`. For HTTPS in the process, HTTP/2 or middleware, pass the handler to a library such as [srvx](https://srvx.h3.dev), and check that it aborts the request signal when the client disconnects; otherwise a closed connection does not cancel the call.

### MCP through stdio

`NodeMcp.main` serves MCP over a Node.js process's standard input and output, for clients that start the server as a local process:

```ts
#!/usr/bin/env node
import { NodeMcp } from "@acid-cat/core-effect/node";

NodeMcp.main(aircon, unitLayer, { name: "aircon", version: "1.0.0" });
```

The [stdio transport](../../spec/surfaces/mcp.md#stdio) defines sessions, revisions, `notifications/tools/list_changed` and cancellation. Package specifics:

- `Mcp.serveStdio(app, options)` runs on the `effect` `Stdio` service, for any runtime, and completes when standard input ends. `Mcp.layerStdio(app, options)` is the same server as a layer.
- Effect logs go to standard error. Do not write to standard output from a capability.
- Events: push and poll ([Events over MCP](#events-over-mcp)). The process has no principal, and webhook delivery answers `Unsupported`.

### Typed calls

A typed call takes the capability object and has its schemas' types. The session accepts only the exact object it serves; another object with the same id is `unknown-capability`.

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

`Handles.open` gives a promise-based session with the same method names ([TypeScript surface](../../spec/surfaces/typescript.md#handles)):

- `session.call(capability, input)` decodes untrusted input and gives `Promise<Result<Value, Failure>>`. A call failure rejects with a `CallFailureError`.
- `session.handle(capability)` gives a typed handle. `execute` takes decoded input; `snapshot` gives the state in JSON form.
- `session.handles` gives the untyped handles by id, for surfaces.
- `await using` or `session.dispose()` closes the session.

```ts
import { Handles } from "@acid-cat/core-effect";

await using session = await Handles.open(aircon, unitLayer, { target: "app" });
const result = await session.call(powerSet, request.body); // Result<null, typeof Offline.Type>
const power = session.handle(powerSet); // Handles.HandleOf<typeof powerSet>
await power.execute({ on: true }); // Result<null, typeof Offline.Type>
```

With the `webmcp` option (a WebMCP host, for example `WebMcp.findHost()`), the session registers its tools on that host until it closes. Otherwise `session.webmcp` is `undefined`.

- `session.webmcp.status` observes the [status](../../spec/surfaces/webmcp.md#status).
- `session.webmcp.retry()` queues the last failed update again; watch `status` for the result.
- `session.webmcp.remove()` removes the tools while the session stays open ([Removal](../../spec/surfaces/webmcp.md#tools)). Calls in progress continue, so a capability can call it during its own call. `status` is `closing` until they end, then `disposed`. The `remove` effect of `WebMcp.install` is the same operation.

```ts
import { Handles, WebMcp } from "@acid-cat/core-effect";

await using session = await Handles.open(aircon, unitLayer, { target: "app", webmcp: WebMcp.findHost() });
session.webmcp?.status.subscribe((status) => render(status.phase));
```

### Follow events

Subscriptions follow the [events specification](../../spec/events.md), including the [failures before the first occurrence](../../spec/events.md#subscribing).

| Effect `Session` | Input | Result |
| --- | --- | --- |
| `session.subscribe(id, input, { cursor, maxAgeMs })` | Untrusted: the input schema decodes it | `Effect<Subscription<unknown>, CallFailed, Scope>`. Each `data` is in its JSON form |
| `session.follow(event, input, { cursor, maxAgeMs })` | Already decoded, with the input's type | `Effect<Subscription<Payload>, CallFailed, Scope>`. Each `data` is a copy, with the payload's type |

A `Subscription<Payload>` is a `Stream<Occurrence<Payload>, CallFailed>`. Closing the scope or interrupting the stream cancels it. As with typed calls, the session accepts only the exact event object it serves.

```ts
const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* Session.make(aircon, { target: "app" });
    const changes = yield* session.follow(statusChanged, {}); // Stream<Occurrence<typeof Status.Type>, CallFailed>
    yield* Stream.runForEach(changes, (occurrence) => Console.log(occurrence.data.celsius));
  }),
);
```

The `eventBuffer` option (`Session.make`, `Handles.open`, the web handlers; default 1024) sets how many unread occurrences each subscription keeps before it drops the oldest ([Slow clients](../../spec/events.md#slow-clients)).

#### Event handles

`session.events` gives the [event handles](../../spec/surfaces/typescript.md#event-handles) by id, and `session.event(event)` gives one typed handle. `subscribe` resolves once the subscription has started; `subscribeExternal` validates untrusted input. A GraphQL `subscribe` resolver can return the promise directly (graphql-ws, GraphQL Yoga, graphql-sse):

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

`POST {base}/events/{id}` streams server-sent events, as the [HTTP surface](../../spec/surfaces/http.md#events) defines. The `keepaliveMs` option (default 15 000) sets the keepalive interval.

#### Events over MCP

When the target has events, the MCP surface serves the [events extension](../../spec/surfaces/mcp.md#events) to `2026-07-28` clients: push (`events/stream`) through HTTP and stdio, [poll](#poll-delivery) through HTTP and stdio, and [webhook](#webhook-delivery) through HTTP when the `webhooks` option is set. The `heartbeatMs` option (default 15 000) sets the push heartbeat interval when the client suggests none. A client that suggests `heartbeatMs` in `events/stream` gets a grant from 1 000 to 60 000 ([Push](../../spec/surfaces/mcp.md#push)).

#### MCP headers

Through HTTP, the MCP surface checks the [headers](../../spec/surfaces/mcp.md#headers) of each request of revision `2026-07-28` against its body: `Mcp-Method`, `Mcp-Name`, and an `Mcp-Param-*` header for each property of the input schema of the tool or the event that has `x-mcp-header`. A mismatch gets 400 and `-32020`. `effect/ai` checks the tools, and the surface checks the events. To annotate a property, give its schema the annotation: `Schema.String.annotate({ "x-mcp-header": "Region" })`. The catalog keeps each annotation whose key starts with `x-`. Annotate the schema before a check such as `Schema.isBetween`: Effect writes the annotation of a checked schema in an `allOf`, where the [header annotation rules](../../spec/surfaces/mcp.md#header-annotations) forbid it. `Schema.Int` already has a check, so annotate an integer before `Schema.isInt`: `Schema.Number.annotate({ "x-mcp-header": "Count" }).check(Schema.isInt())`. An annotation of a `Schema.NullOr` member is in an `anyOf`, which the rules also forbid. `acid-cat check` rejects a catalog with an annotation at such a location.

#### Poll delivery

[Poll](../../spec/surfaces/mcp.md#poll) defines leases and cursors. The `poll` option sets the lease limits:

| `poll` option | Default | Use |
| --- | --- | --- |
| `leaseMs` | `300000` | A lease that gets no poll for this long ends, and its subscription is cancelled |
| `bufferLimit` | `1000` | How many occurrences a lease keeps. When the buffer is full, the lease drops the oldest, and a poll with an older cursor gets `truncated: true` |
| `maxEvents` | `100` | How many occurrences a result holds when the request gives no `maxEvents`. With more, the result has `hasMore: true` |
| `nextPollMs` | `2000` | The `nextPollMs` of each result |

The `principal` option of `Mcp.toWebHandler`, `(request: Request) => Effect<Option<string>>`, gives each request's client identity: check the credentials there. Leases are keyed by principal, so a client cannot read another principal's lease. With no principal, all clients with the same event and input share a lease.

Leases live in process memory and are lost on restart:

- A lease opens its session with the services of the request that started it. With `services: "per-request"`, those services stay open until the lease ends.
- `handler.dispose()` ends all leases and webhook subscriptions and releases the shared services.
- `Mcp.makeHandle(app, options)` answers each request like `Mcp.handle` and keeps leases and webhook subscriptions in its scope. `Mcp.handle` keeps no state, so it delivers by push only; `events/poll` and the webhook methods answer `Unsupported`.

#### Webhook delivery

The `webhooks` option turns on [webhook delivery](../../spec/surfaces/mcp.md#webhook), through HTTP only. It needs the `principal` option; a request with no principal gets `Forbidden`.

```ts
import * as NodeWebhook from "@acid-cat/core-effect/NodeWebhook";

const mcp = Mcp.toWebHandler(aircon, unitLayer, {
  ...mcpOptions,
  principal: (request) => verifyBearerToken(request), // Effect<Option<string>>
  webhooks: { sender: NodeWebhook.sender() },
});
```

The specification defines subscription, verification, signing, retries and network safety. The options:

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
| `signingKeys` | None | Ed25519 keys, as private JWKs, that also [sign each request](../../spec/surfaces/mcp.md#webhook). To change keys, give the new key beside the old one |
| `egressIpRanges` | None | The IP ranges from which the server sends, as CIDR text, for the Server Card |

A signing key or an egress range that breaks the rules of [webhook delivery](../../spec/surfaces/mcp.md#webhook) makes the server fail when it starts.

`NodeWebhook.sender` follows the spec's network safety rules: it resolves the host for each request, connects only to globally routable addresses (pinned, with the host name in `Host` and TLS), follows no redirects, and reads at most `maxResponseBytes`.

| `NodeWebhook.sender` option | Default | Use |
| --- | --- | --- |
| `allowPrivateNetworks` | `false` | Also connect to loopback, private, link-local and other addresses that are not globally routable. Use it only for tests, or when every endpoint is in a network that you control |
| `ca` | None | PEM certificate authorities to trust in addition to Node.js's own, for example a test endpoint's |
| `maxResponseBytes` | `65536` | The most bytes of an answer that the sender reads |

Subscriptions, verifications and limit counts live in process memory and are lost on restart.

#### Server Card

`Mcp.toWebHandler`, `Mcp.makeHandle` and `Mcp.handle` serve an MCP [Server Card](../../spec/surfaces/mcp.md#server-card) at the URL of the server and `/server-card`, for example `/mcp/server-card`. It is on by default. `serverCard: false` turns it off.

| Option | Default | Use |
| --- | --- | --- |
| `serverCard.name` | From the host of the URL and `name` ([Default name](../../spec/surfaces/mcp.md#default-name)) | The name of the server in a registry. `name` stays the name that `server/discover` gives |
| `serverCard.description` | The description of the catalog, else `instructions`, else `name` ([Default description](../../spec/surfaces/mcp.md#default-description)) | |
| `serverCard.url` | The URL of the request, without `/server-card` | Give the `https` URL when a platform in front of the server ends TLS |

With webhook delivery, the card also gives the public keys of `signingKeys` and the `egressIpRanges`. `Mcp.withHandshake` adds its revisions to the card. A setting that breaks the [startup rules of the card](../../spec/surfaces/mcp.md#server-card), such as a `version` range with the card on, makes the server fail when it starts. The defaults never make it fail.

```ts
const mcp = Mcp.withHandshake(
  Mcp.toWebHandler(aircon, unitLayer, {
    ...mcpOptions,
    serverCard: { name: "com.example/aircon" },
    webhooks: { sender: NodeWebhook.sender(), signingKeys: [signingJwk], egressIpRanges: ["203.0.113.0/24"] },
  }),
);
```

`Mcp.withEvents` also serves a card, for your own server, with the same `serverCard` option. For each `GET` request of the card, it sends `server/discover` of revision `2026-07-28` to your server, with no `Origin` and no credentials. The card takes the version, the revisions, the default name and the default description from that result, so it always agrees with your server. When the result cannot give a card, the request of the card gets 502 Bad Gateway, as the [surface](../../spec/surfaces/mcp.md#server-card) tells. A server that requires credentials answers `server/discover` with an error, so give it `serverCard: false`. `signingKeys` and `egressIpRanges` work with `Mcp.withEvents` too.

#### Events beside your own MCP server

`Mcp.withEvents(app, layer, server, options)` adds the application's events to your own `effect/ai/McpServer` web handler. It screens each request as `Mcp.toWebHandler` does, answers the events extension requests itself, and passes every other request to your server. Give your server `Mcp.eventsExtensions` as its `extensions`, so `server/discover` declares the extension.

```ts
const server = McpServer.toolkit(MyTools).pipe(
  Layer.provide(handlers),
  Layer.provideMerge(McpServer.layerHttp({ name: "aircon", version: "0.1.0", path: "/mcp", protocols: [McpProtocol.v2026_07_28], extensions: Mcp.eventsExtensions })),
  Layer.provide(unit),
);
const application = HttpRouter.toWebHandler(server);
const mcp = Mcp.withEvents(aircon, unit, application.handler, { allowedOrigins: [] });
```

Options: `allowedOrigins`, `target`, `maximumBytes`, `services`, `heartbeatMs`, `eventBuffer`, `principal`, `poll`, `webhooks` and `serverCard` ([Server Card](#server-card)). `mcp.dispose()` ends leases and webhook subscriptions, not your server.

#### Events in other surfaces

The command line follows events with `watch <id>` ([Follow an event](#follow-an-event)). WebMCP serves no events; the page uses the event handles.

### Services for each request

By default, a web handler builds `layer` once and all requests share it. With `services: "per-request"`, it builds the layer for each screened request and releases it after the response (or when a server-sent events stream ends). Use it when requests must not share objects (Cloudflare Workers) or a stateful service:

```ts
const handler = Mcp.toWebHandler(app, makeLayer(env), { ...options, services: "per-request" });
```

A per-request layer can read the request head (method, URL, headers) from `Remote.IncomingRequest`, for example to find the caller. The types refuse it in a shared layer.

`Remote.refuse(status, message, headers?)` fails the layer with a `Remote.Refusal`. The handler answers with that status and headers and the JSON body `{ "message": message }`, and no session opens. The status must be an integer from 400 to 599 (otherwise `RangeError`). Keep internal data out of the message.

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

A poll lease or webhook subscription keeps the services, and so the caller, of the request that started it. Set the MCP `principal` option from the same caller; otherwise two callers polling the same event and input share one lease and the second reads the first caller's session. `Mcp.withEvents` refuses only events extension requests; your own server authenticates the rest.

`Mcp.handle(app, request, options)` and `Http.handle(app, request, options)` answer one request for a host that builds the services itself. Give `Remote.IncomingRequest` the value `Remote.headOf(request)`. For poll and webhook delivery, use `Mcp.makeHandle` ([Poll delivery](#poll-delivery)).

### Command line

The command line serves the catalog of the `cli` target as the [CLI surface](../../spec/surfaces/cli.md#commands) defines: command paths, flags, repeated flags, `call`, `list`, usage, help and exit codes. Effect logs go to standard error.

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

Package specifics:

- A command line that breaks a surface rule (a capability path that is a prefix of another, a duplicate path) fails at startup: `Cli.command` throws, `Cli.run` and `Cli.runCommand` die, and `NodeCli.main` and `NodeCli.runCommand` write the message to standard error and exit with 5.
- The surface's help replaces the `effect/cli` help for capability commands, aliases, events and shared prefixes. The root command, `call`, `list` and `watch` keep the `effect/cli` help.
- On `SIGINT`, `NodeCli` interrupts the fiber of the call or subscription. If it has not ended after `INTERRUPT_GRACE_MS` (1 second, from `@acid-cat/spec-ts`), the process exits with 130 and writes nothing more. A second interrupt exits at once. When the run ends with no interrupt, `NodeCli` no longer listens for interrupts.

#### Follow an event

`watch <id>` subscribes and writes each occurrence as one line of JSON. `--cursor` and `--max-age-ms` resume; see [Events](../../spec/surfaces/cli.md#events) for the rules and exit codes.

```sh
node cli.ts watch aircon.status.changed | jq .data.celsius
node cli.ts watch aircon.status.changed --cursor "$(tail -n 1 status.jsonl | jq -r .cursor)" --max-age-ms 600000 >> status.jsonl
```

#### Aliases

The `cli` target's `cli` member declares [aliases](../../spec/surfaces/cli.md#aliases). `App.alias(capabilityOrEvent, fixedInput?)` makes one; the fixed input has the encoded type of the input schema. `App.aliasDefault` also makes it the default alias. The catalog writes them in `options.cli`:

```ts
targets: {
  cli: {
    surfaces: ["cli"],
    cli: {
      aliases: {
        status: App.aliasDefault(statusGet),
        "--on": App.alias(powerSet, { on: true }),
        "--off": App.alias(powerSet, { on: false }),
        "aircon power": App.alias(powerSet),
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
node cli.ts aircon power --on  # a prefix default: aircon power set --on
```

The specification gives the naming, group, prefix default and dispatch rules. An alias that breaks one makes `Cli.command` throw at startup. `Cli.runCommand` stops with a defect at startup when a flag of the default alias has the name of an `effect/cli` or application global flag.

#### Output for a person

The command line writes JSON. A result, a failure and the output of `list` are one line of JSON when standard output is not a terminal, and have an indent of 2 on a terminal. The layout follows the `Cli.Terminal` reference, also without the `output` option.

The `output` option (a `Cli.Output`) adds a human form, which the [spec](../../spec/surfaces/cli.md#outcomes) leaves to each core. Without it, output is always JSON and there are no output flags.

- `flags`: the output flags. Each has `names` (`--word`, or `-x` with one letter or digit), and either `form` for a switch (`{ names: ["--json"], form: "json" }`) or `values` for a flag with a value (`{ names: ["--format", "-f"], values: { text: "human", json: "json" } }`).
  - An output flag can be anywhere before a later `--`; `runCommand` removes it before `effect/cli` parses. For an application command, it must come before the command name, and the command reads the choice with `Cli.outputForm`.
  - The last output flag wins. A missing or unknown value exits with 3: `The option --format must be json or text.`
- `default`: `"json"` (the default) or `"auto"`. `"auto"` picks human only when standard output is a terminal, `CI` is not set, and no coding agent variable (such as `CLAUDECODE` or `CODEX_THREAD_ID`) is set. A variable is set unless empty, `0`, `false`, `no` or `off`. `Cli.formOf(stdoutIsTerminal, environment)` makes this decision. `Cli.run` and `Cli.runCommand` read the terminal from the `Cli.Terminal` reference (default: no terminal, so tests get JSON); `NodeCli` gives the real one.
- `formats`: the formatters (below).

The root help lists the output flags under `OUTPUT FLAGS`. An output flag may be named `-h`; `--help` still writes the help.

`Cli.command` throws at startup when an output flag's name is invalid, duplicated, or taken (`--help`, `--version`, `--cursor`, `--max-age-ms`, a flag alias, an input flag in the target). `runCommand` stops with a defect when it clashes with an `effect/cli` flag (such as `--log-level`) or an application global flag.

In the human form, exit codes and streams stay the same. Text has color only on a terminal without `NO_COLOR`. A call failure is `error (<kind>): <message>` on standard error, `list` is a table, and `watch` writes one block per occurrence. Help, `--version` and usage errors do not change.

Without a formatter, `Cli.layout(value)` writes a generic layout: one line per object member, a table for an array of objects, comma-separated scalars.

`App.format` makes a formatter. It gets the value decoded with its schema (`Type` form) and `ui`: the styles `bold`, `dim`, `ok`, `warn`, `error`, and `table(header, rows)`. From [`examples/aircon/core-effect/output.ts`](../../examples/aircon/core-effect/output.ts):

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

- `App.format(capability, { value, failures })` takes optional formatters for the value and each failure tag; `App.format(capability, value)` and `App.format(event, payload)` take one. TypeScript checks the tags and types.
- A `null` value writes nothing. If decoding or the formatter fails, the generic layout is written, with the same exit code.
- `Cli.command` throws at startup on two formats for one id, or a format for an id outside the target.

#### Command line that calls a server

With the `remote` option, the command line is a client of a server's HTTP surface, as [Server](../../spec/surfaces/cli.md#server) defines. `Http.client(base, options)` makes the client:

```ts
import { Http } from "@acid-cat/core-effect";
import { NodeCli } from "@acid-cat/core-effect/node";

NodeCli.main(aircon, unitLayer, {
  name: "aircon",
  version: "0.1.0",
  remote: Http.client("http://pi.local:8080/cli", { headers: { Authorization: `Bearer ${token}` } }),
});
```

- `options.headers` go on each request and are never written to the output.
- `options.layer` gives the `effect/http` client. The default `FetchHttpClient.layer` uses `globalThis.fetch`; pass another, for example to trust a certificate.
- `Http.client` throws when `base` is not an `http` or `https` URL or a header is invalid. The message contains no header value.
- No session opens in the process, but `NodeCli.main` still builds the services layer.

On the server, serve the HTTP surface with the command line's target, so both have the same target catalog:

```ts
const cli = Http.toWebHandler(aircon, unitLayer, { allowedOrigins: [], base: "/cli", target: "cli" });
yield* NodeServer.serve({ "/cli": cli }, { hostname: "0.0.0.0", port: 8080 });
```

[`examples/aircon/core-effect/serve.ts`](../../examples/aircon/core-effect/serve.ts) serves the air conditioner this way, and [`examples/aircon/core-effect/cli.ts`](../../examples/aircon/core-effect/cli.ts) calls it when `AIRCON_URL` is set. Other Effect code can also call a server with an `Http.Client`: `client.invoke(id, input)`, `client.capabilities` and `client.subscribe(id, input, resume)`.

#### Application flags

`Cli.command(app, options)` gives the `effect/cli` command. Add flags with `effect/cli`, then run it with `Cli.runCommand` or `NodeCli.runCommand`, which set the surface's exit codes. `Cli.exitCodeOf(error)` gives a usage error's exit code.

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

The `commands` option adds `effect/cli` commands. `Cli.command` throws at startup on a name that the [surface forbids](../../spec/surfaces/cli.md#commands). The `description` option sets the top of the help; it defaults to the application's description, then its title, then the program name.

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

The package runs everywhere, browsers included; only `/node` and `/NodeServer` need Node.js. Each module also has its own entry point (`@acid-cat/core-effect/Session`). The package has no side effects, so a page that imports `Session`, `Handles` and `WebMcp` bundles no `Cli`, `Mcp`, `effect/cli` or `effect/ai`.

## Examples and tests

- [`examples/aircon/core-effect`](../../examples/aircon/README.md): an air conditioner with its command line. [`examples/aircon/apis/mcp.ts`](../../examples/aircon/apis/mcp.ts) adds its own MCP tools beside the surface.
- `moon run core-effect:test` tests sessions, handles and every surface, and runs `acid-cat conform` against each protocol surface, with the apps in [`test/`](test/):
  - [`test/fixture.ts`](test/fixture.ts): one capability per `acid-cat conform` behavior. CLIs: [`test/fixture-cli.ts`](test/fixture-cli.ts), [`test/fixture-cli-remote.ts`](test/fixture-cli-remote.ts) (calls a server).
  - [`test/events-fixture.ts`](test/events-fixture.ts): one event per subscription behavior (filters, cursors, a defect, a bad payload, an event outside the target). CLI: [`test/events-cli.ts`](test/events-cli.ts).
  - [`test/lamp.ts`](test/lamp.ts): a smart lamp with shared types, failures, state and availability. CLI: [`test/lamp-cli.ts`](test/lamp-cli.ts), run as a separate process.
- The heartbeats, poll leases and webhook timers of `Mcp.toWebHandler` (lifetimes, retries and the wait for each answer) use the `Clock` of its layer. A test gives a `TestClock` in the layer and moves it with `adjust`, as [`test/test-clock.ts`](test/test-clock.ts) does.
