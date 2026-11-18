# @acid-cat/core-ts

`@acid-cat/core-ts` is an AcidCat core in plain TypeScript. You define capabilities and events once, and the package serves them through the TypeScript, HTTP, MCP, CLI and WebMCP bindings. It is one implementation of the [AcidCat specification](../../spec/README.md).

Use it if you want AcidCat without Effect. A capability is an async function that returns a promise, and an event is an async iterable. Validate inputs with any [Standard Schema](https://standardschema.dev) library, such as Zod, Valibot or ArkType. The application writes its own catalog from its code.

```sh
pnpm add @acid-cat/core-ts
```

## Quick start

This program is a command line with one command:

```ts
import { capabilitiesFor, cliMain, defineApp, ok } from "@acid-cat/core-ts";
import type { ToJsonSchema } from "@acid-cat/core-ts";
import { z } from "zod";

type Context = { lamp: { on: boolean } };
const capability = capabilitiesFor<Context>();

const app = defineApp<Context>({
  title: "Desk lamp",
  targets: { cli: { bindings: ["cli"] } },
  capabilities: [
    capability({
      id: "lamp.power.set",
      description: "Turn the lamp on or off.",
      audience: ["cli"],
      input: z.object({ on: z.boolean() }),
      output: z.object({ on: z.boolean() }),
      run: async ({ on }, { context }) => {
        context.lamp.on = on;
        return ok({ on });
      },
    }),
  ],
});

const toJsonSchema: ToJsonSchema = (schema) => {
  if (!(schema instanceof z.ZodType)) throw new Error("Only Zod schemas.");
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
};

cliMain(app, { name: "lamp", version: "0.1.0", context: { lamp: { on: false } }, toJsonSchema });
```

```sh
$ node lamp.ts lamp power set --on
{
  "on": true
}
```

To serve the same app over HTTP or MCP, add those bindings to a target and pass the app to `httpHandler` or `mcpHandler`. See [Serve capabilities and events](#serve-capabilities-and-events).

## Write capabilities

```ts
import { capabilitiesFor, defineApp, fail, ok } from "@acid-cat/core-ts";
import { z } from "zod";

const Offline = z.object({ _tag: z.literal("Offline") });
const capability = capabilitiesFor<{ unit: Unit }>();

export const aircon = defineApp<{ unit: Unit }>({
  title: "Living-room air conditioner",
  targets: { cli: { bindings: ["cli"] }, mcp: { bindings: ["mcp"] } },
  capabilities: [
    capability({
      id: "aircon.power.set",
      description: "Turn the unit on or off.",
      audience: ["cli", "mcp"],
      input: z.object({ on: z.boolean() }),
      failures: { Offline },
      run: async ({ on }, { context, signal }) => ((await context.unit.setPower(on, signal)) ? ok(null) : fail({ _tag: "Offline" })),
    }),
  ],
});
```

`capabilitiesFor<Context>()` sets the context type once. Every other type comes from the schemas.

- `run(input, { signal, context, target })` gets the decoded input (an empty object if there is no input schema), an `AbortSignal`, the context, and the session's target, such as `"mcp"` or `"cli"`.
- `run` returns `ok(value)` or `fail(failure)`, for example `fail({ _tag: "Offline", since })`. The types check that the value matches the output schema, and that the failure has a tag from `failures` and the members of that tag's schema. If `run` throws, the call fails as `internal`.
- A failure schema describes the whole failure object, including its `_tag`.
- `readOnly`, `destructive` and `idempotent` are optional boolean [hints](../../spec/catalog.md#capabilities) for clients. The MCP binding sends them as the tool annotations `readOnlyHint`, `destructiveHint` and `idempotentHint`.
- `availability` is an optional function that returns an observable availability. The session reads it with `getSnapshot` when a call arrives, and subscribes to it only while `onChange` or the handle has listeners.
- `state` is an optional `{ schema, source }`: the [state](../../spec/invocation.md#state) schema, and a function that returns an observable. The handle exposes it as `snapshot`.
- `run`, `availability` and `state` all get the same `Context`.
- `defineCapability` and `capabilitiesFor` keep the literal type of `id`, so an application can type its ids.
- An application lists only capabilities made by `defineCapability` or `capabilitiesFor`. Each one has `decode`, which validates an untrusted input against the input schema and returns the call of `run`. Sessions use it because they do not know the input type.

## Write events

An [event](../../spec/events.md) is a kind of thing that happens, which clients can follow. `subscribe` returns an async iterable, such as an async generator, with one value per occurrence.

```ts
import { eventsFor } from "@acid-cat/core-ts";

const Status = z.object({ on: z.boolean(), celsius: z.number() }).meta({ id: "Status" });
const event = eventsFor<{ unit: Unit }>();

export const statusChanged = event({
  id: "aircon.status.changed",
  description: "The status of the unit changed.",
  audience: ["app", "mcp"],
  input: z.object({}),
  payload: Status,
  async *subscribe(_input, { context, signal }) {
    for await (const status of context.unit.changes(signal)) yield { data: status };
  },
});

export const aircon = defineApp<{ unit: Unit }>({ targets, capabilities: [powerSet], events: [statusChanged] });
```

- `subscribe(input, { signal, context, target, cursor, maxAgeMs })`. The signal aborts when the subscription ends, however it ends. Stop the work and release resources then.
- Each value is `{ data }`, with optional `eventId`, `timestamp`, `cursor` and `truncated`. Pass the source's `eventId` if it has one; otherwise the session makes a unique id. Without `timestamp`, the session uses the time it received the value.
- `data` must match the payload schema. The client gets a copy of the schema's output. With no payload schema, `data` must be an empty object.
- If `subscribe` throws before it returns an iterable, the subscription fails as `internal` before it starts. If the iterable throws, or yields data that does not match the payload schema, the subscription ends with `internal`. The details go to `onDefect`, not to the client.
- When the iterable ends, the subscription is complete.
- The session asks for the first value before the `subscribe` promise resolves, so an async generator runs up to its first `await` or `yield` before the client gets the iterable. Register a listener on the source before that point, and the subscription sees every change after `subscribe` resolves.
- To support resuming, give a `cursor` with each value. A client can pass `cursor` and `maxAgeMs` when it subscribes: start after the cursor, and skip occurrences older than `maxAgeMs`. If you skip occurrences, set `truncated: true` on the first value. An event that gives no cursors ignores them.
- `defineEvent` and `eventsFor` keep the literal type of `id`. Capabilities and events share one set of ids.

## Write the catalog

```ts
import { writeFile } from "node:fs/promises";
import { renderCatalog } from "@acid-cat/core-ts";

const toJsonSchema = (schema) => z.toJSONSchema(schema, { target: "draft-2020-12" });
await writeFile("acidcat.catalog.json", renderCatalog(aircon, { toJsonSchema })); // canonical form
```

Standard Schema has no JSON Schema conversion, so pass your schema library's converter as `toJsonSchema`. The catalog has an `events` member when the application has events.

## Serve capabilities and events

| Function | Binding | Result |
| --- | --- | --- |
| `createSession(app, options)` | [TypeScript](../../spec/bindings/typescript.md) | A session with a handle for each capability and an event handle for each event in the view |
| `mcpHandler(app, options)` | [MCP](../../spec/bindings/mcp.md#http) over HTTP | `(request: Request) => Promise<Response>` |
| `mcpHandshake(handler)` | [MCP](../../spec/bindings/mcp.md#earlier-revisions-through-http) over HTTP, earlier revisions | The handler, which also serves the `initialize` handshake of earlier revisions. From [`@acid-cat/mcp-handshake`](../mcp-handshake) |
| `mcpStdioMain(app, options)`, `runMcpStdio(…)` | [MCP](../../spec/bindings/mcp.md#stdio) over stdio | The process's MCP server, or a promise that resolves when the input ends |
| `httpHandler(app, options)` | [HTTP](../../spec/bindings/http.md) | `(request: Request) => Promise<Response>` |
| `cliMain(app, options)`, `runCli(…)` | [CLI](../../spec/bindings/cli.md) | The process's command line, or an exit code |
| `httpClient(url, options)` | [CLI](../../spec/bindings/cli.md#server), [HTTP](../../spec/bindings/http.md) | A client for a server's HTTP binding, for the command line's `remote` option |
| `installWebMcp(session)` | [WebMCP](../../spec/bindings/webmcp.md) | Tools in the page, with a status. WebMCP serves no events |
| `serve(handler, options)`, from `@acid-cat/core-ts/node` | MCP and HTTP | A Node.js server for the web handlers. See [Serve on Node.js](#serve-on-nodejs) |

When a request's signal aborts, `mcpHandler` and `httpHandler` cancel that request's call or subscription.

Each binding serves the events in its view:

| Binding | Events |
| --- | --- |
| TypeScript | `session.eventHandle(event).subscribe(input)`. See [Event handles](#event-handles) |
| HTTP | `GET {base}/events` lists them. `POST {base}/events/{id}` returns a server-sent event stream: `event: next` per occurrence, then `event: complete`, or `event: error` with `internal`. `Last-Event-ID` carries the cursor and `?maxAgeMs=` carries `maxAgeMs`. The `keepaliveMs` option (15 seconds) sets how long a stream stays idle before it gets a comment line |
| MCP | The MCP events extension, revision `2026-07-28` only: `events/list`, push delivery with `events/stream`, poll delivery with `events/poll`, and, over HTTP when the deployment enables it, webhook delivery with `events/subscribe` and `events/unsubscribe`. Over HTTP, the `events/stream` response is a server-sent event stream. The `heartbeatMs` option (15 seconds) sets how long a stream stays idle before it gets `notifications/events/heartbeat`. A client that used the `initialize` handshake gets no events. See [MCP poll and webhook delivery](#mcp-poll-and-webhook-delivery) |
| CLI | `watch <id>` writes each occurrence on one line. See [Command line](#command-line) |

The `bufferLimit` option of `createSession`, `httpHandler`, `mcpHandler` and `runMcpStdio` sets how many occurrences each subscription keeps for a slow client. The default is 256. When the buffer is full, the oldest occurrence is dropped, and the next occurrence the client reads has `truncated: true`.

### MCP poll and webhook delivery

A poll lease and a webhook subscription outlive the request that started them. Each holds its subscription in its own session. Over HTTP, that session has the starting request's context: the shared `context`, or the one `createContext` made for that request. Over stdio, it has the process's `context`. The session closes when the lease or webhook subscription ends. This state lives in memory, so it is lost when the process stops, and clients start again from their cursors.

`handler.close()` on an `mcpHandler` ends all leases and webhook subscriptions. `await using handler = mcpHandler(…)` calls it at the end of the block. Over stdio, the end of standard input ends them.

#### Poll

`events/poll` reads a lease's occurrences ([spec](../../spec/bindings/mcp.md#poll)). Both `mcpHandler` and `runMcpStdio` serve it. A lease's key is the principal, the event id and the input, so two polls from the same client with the same input read one lease. The `poll` option sets the limits:

| `poll` option | Default | Meaning |
| --- | --- | --- |
| `leaseMs` | 5 minutes | A lease that gets no poll for this long ends, and its subscription is cancelled |
| `bufferLimit` | 1000 | Occurrences each lease keeps. When the buffer is full, the oldest is dropped. A cursor older than the buffer gets `truncated: true` |
| `maxEvents` | 100 | Occurrences in a result when the request gives no `maxEvents` |
| `nextPollMs` | 2000 | The `nextPollMs` of each result |

A poll cursor encodes the lease, the position in its buffer, and the provider's last cursor. After a lease ends, a poll with its cursor starts a new lease that resumes after that provider cursor, with `maxAgeMs`.

#### Principal

The `principal(request)` option of `mcpHandler` returns the identity of a request's client, such as the subject of a verified token, or `undefined` if there is none. It is part of the key of each lease and webhook subscription, so one client cannot read another's lease. Over stdio, the process serves one client and leases have no principal.

#### Webhook

Webhook delivery is off by default and works only over HTTP. Enable it with the `webhooks` option and `webhookDelivery(options)` from `@acid-cat/core-ts/node`. It sends each occurrence in a signed `POST` request to the client's URL ([spec](../../spec/bindings/mcp.md#webhook)). It needs `principal`: a request with no principal gets `Forbidden`.

```ts
import { mcpHandler } from "@acid-cat/core-ts";
import { serve, webhookDelivery } from "@acid-cat/core-ts/node";

const mcp = mcpHandler(aircon, {
  name: "aircon",
  version: "1.0.0",
  allowedOrigins: [],
  toJsonSchema,
  context: { unit },
  principal: (request) => verifiedSubject(request), // string | undefined
  webhooks: webhookDelivery({ maxTtlMs: 3_600_000 }),
});
await serve({ "/mcp": mcp });
```

| `webhookDelivery` option | Default | Meaning |
| --- | --- | --- |
| `allow(url)` | None | The allowlist. A URL for which it returns `true` gets deliveries without verification |
| `allowPrivateNetworks` | `false` | Also connect to addresses that are not globally routable. For tests and private networks only |
| `ca` | None | Extra certificate authorities to trust, in PEM form |
| `maxTtlMs`, `minTtlMs` | 1 hour, 1 minute | Bounds on the lifetime the server grants for `ttlMs` |
| `maxSubscriptions` | 100 | Maximum webhook subscriptions per principal. Above it, `ResourceExhausted` |
| `attempts`, `retryWindowMs` | 5, 15 minutes | Attempts per delivery, and the time window for them |
| `retryDelayMs(attempt)` | 10 s, 30 s, 90 s, 270 s | The wait before the next attempt |
| `timeoutMs` | 5 seconds | How long the server waits for each response |
| `rotationGraceMs` | 5 minutes | After a new secret, how long the server signs with both the old and the new secret |

Before the first delivery, each principal and URL pair must agree to receive deliveries: either the URL is on the allowlist, or the endpoint answers the `verification` message with its challenge. The server remembers each verification while the process runs. A refresh with the same key grants a new lifetime and replaces the secret. The server sends a subscription's deliveries one at a time, in order. Each delivery's `cursor` is the watermark: the last cursor of an occurrence whose delivery succeeded or was abandoned.

Security:

- The URL must use `https`. The server checks the endpoint's certificate.
- For each request, the server resolves the host name and connects only to a globally routable address, unless `allowPrivateNetworks` is `true`. It connects to the address it checked, with the host name in the `Host` header and in TLS, so a DNS change between the check and the connection has no effect. It does not follow redirects.
- `lastError` and the reason in `CallbackEndpointError` are categories such as `http_4xx` or `tls_error`. The server never passes on the endpoint's response text.
- The server never logs or returns a secret.

The `clock` option of `mcpHandler`, `runMcpStdio` and `webhookDelivery` supplies the time and the timers for leases, lifetimes and retries. The default is the system clock. Tests pass a clock they control.

### Serve on Node.js

`@acid-cat/core-ts/node` serves web handlers on Node.js using only `node:http`, with no other dependency.

```ts
import { serve } from "@acid-cat/core-ts/node";

const mcp = mcpHandler(aircon, { name: "aircon", version: "1.0.0", allowedOrigins: [], toJsonSchema, context: { unit } });
const http = httpHandler(aircon, { allowedOrigins: [], toJsonSchema, context: { unit } });

const server = await serve({ "/mcp": mcp, "/": http }, { port: 3000 });
console.log(server.url); // http://127.0.0.1:3000
```

`serve(handler, options)` takes one handler for every path, or handlers by path prefix. The longest matching prefix gets the request, and `/` matches every path. The MCP handler answers on every path, so give it its own prefix. A path that matches no prefix gets `404`. A handler that rejects gets `500`.

| Option | Default | Meaning |
| --- | --- | --- |
| `port` | `3000` | The port. With `0`, the system picks a free port, and `server.port` returns it |
| `hostname` | `127.0.0.1` | The address. The default accepts connections from the same computer only. Use `0.0.0.0` or `::` to accept connections from the network |

`serve` resolves once the server listens. `server.close()` stops it, and `await using server = await serve(…)` closes it at the end of the block. When a client closes its connection, its request's signal aborts, so the handler cancels the call.

`serve` is a plain HTTP/1.1 server without HTTPS. When clients connect over a network, terminate TLS in front of it on the platform: a load balancer, a Kubernetes ingress (for example with cert-manager for certificates), or a tunnel such as Cloudflare Tunnel. The platform sends plain HTTP to the server over its private network. Set `hostname` to `0.0.0.0` or `::` so the platform can connect. Do not put an in-process TLS proxy in front of `serve`.

For more features, give the handler to a web handler library such as [srvx](https://srvx.h3.dev): in-process HTTPS when TLS must reach the server, HTTP/2, middleware, or the same server code on Bun and Deno. Check that the library aborts a request's signal when the client closes the connection. If it does not, a closed connection does not cancel the call.

### MCP over stdio

An MCP client, such as a coding agent, can start the server as a local process. `mcpStdioMain` serves the process's standard input and output.

```ts
#!/usr/bin/env node
import { mcpStdioMain } from "@acid-cat/core-ts";

mcpStdioMain(aircon, { name: "aircon", version: "1.0.0", context: { unit }, toJsonSchema });
```

- The process is one session with one `context`.
- The server serves revision `2026-07-28`, and the `initialize` handshake of revisions `2025-11-25` and `2025-06-18`.
- When a capability's availability changes, the server sends `notifications/tools/list_changed`.
- `notifications/cancelled` cancels a call or an `events/stream` request.
- When standard input ends, the session closes: calls in progress are cancelled, and each subscription is complete.
- Standard output carries only MCP messages, and the session writes defects to standard error. Do not write to standard output from a capability.

`runMcpStdio(app, options, { input, write })` is the same server on any stream, and works in every runtime. `input` is an async iterable of bytes or text, such as a `ReadableStream`, and `write` writes one line.

### Typed calls and handles

`createSession` returns a `Session<Context>`. It offers two typed ways to call a capability. Both take the capability object, so the types come from its schemas:

- `session.call(capability, input)` takes an untrusted input, such as a request's arguments. The capability's input schema checks it, and the result has the capability's types. An input that does not match rejects as `invalid-input`.
- `session.handle(capability)` returns the capability's [handle](../../spec/bindings/typescript.md#handles): its availability, its state `snapshot`, and `execute` for an input the types already check.

Both go through the session, which applies availability, cancellation, and the output and failure checks. The session must serve that exact capability object. For any other capability, even one with the same id, a call rejects as `unknown-capability` and the handle is always unavailable.

`session.handles` maps ids to handles, for bindings. A handle from that map has the input type `never`: call it with `invokeExternal`, which validates the input. A function that takes a session declares its context: `(session: Session<{ unit: Unit }>) => …`.

A session is async-disposable. `await using` closes it at the end of the block, as `dispose()` does:

```ts
import { createSession } from "@acid-cat/core-ts";

await using session = createSession(aircon, { target: "app", context: { unit }, toJsonSchema });
const result = await session.call(powerSet, request.body); // Result<null, { readonly _tag: "Offline"; since?: string }>
if (!result.ok) console.log(result.error._tag); // "Offline"

const power = session.handle(powerSet);
power.availability.subscribe(render);
await power.execute({ on: true });
```

### Event handles

`session.eventHandle(event)` returns the event's [event handle](../../spec/bindings/typescript.md#event-handles), typed from its schemas. `session.eventHandles` maps ids to event handles, for bindings. A handle from that map has the input type `never`: subscribe with `subscribeExternal`, which validates the input.

```ts
const status = session.eventHandle(statusChanged);
for await (const occurrence of await status.subscribe({})) {
  render(occurrence.data); // { on: boolean; celsius: number }
}
```

- The `subscribe` promise resolves once the subscription has started. Before that, it rejects with a `CallFailureError`:
  - `unknown-capability` for an event the session does not serve;
  - `invalid-input` for an input that does not match the schema, or a `maxAgeMs` that is not a non-negative integer;
  - `cancelled` when the session closes or the signal aborts.
- The result is an async iterator of occurrences: `eventId`, `name`, `timestamp`, `data`, plus `cursor` and `truncated` when present. `return()` cancels the subscription, even while a `next()` is waiting; that `next()` resolves with `done: true`. `await using` also cancels it at the end of the block.
- The options are `signal`, `cursor` and `maxAgeMs`.
- When the session closes, each subscription is complete. On `internal`, `next()` rejects with a `CallFailureError`, then resolves with `done: true`.
- A session can hold any number of subscriptions at once. Cancelling one does not affect the others.

A GraphQL server can use an event handle as a subscription source. Return the `subscribe` promise from the field's `subscribe` resolver. GraphQL calls `return()` when the client ends the subscription, over WebSockets (graphql-ws) or server-sent events (graphql-sse, GraphQL Yoga):

```ts
subscription: { statusChanged: { subscribe: () => status.subscribe({}), resolve: (occurrence) => occurrence.data } }
```

### WebMCP

`installWebMcp(session, { host })` registers each available capability in the session's view as a [WebMCP](../../spec/bindings/webmcp.md) tool. Use it in a web page, with a session for a target that has the `webmcp` binding. The host is the `host` option, or else `findHost()`, which tries `document.modelContext`, then `navigator.modelContext`. With no host, `installWebMcp` returns `undefined` and the page works without tools.

```ts
const session = createSession(app, { target: "app", context, toJsonSchema });
const webmcp = installWebMcp(session);
webmcp?.status.subscribe(({ phase, message }) => console.log(phase, message));
```

- Each tool's name is its capability's id, with the capability's description and bundled input schema. A value or a failure is the tool's result. A call failure rejects with an `Error` that has its `kind`. The host's signal cancels the call.
- The tools follow availability: a capability that becomes unavailable loses its tool and gets it back when it is available again. The binding makes one update at a time. A failed update leaves the page's existing tools in place.
- `status` is an observable `{ phase, message }`. The phases are `loading`, `reconciling`, `ready`, `failed`, `closing` and `disposed`. `retry()` retries the last failed update. `dispose()` removes all tools and waits for calls in progress.
- WebMCP serves no events.

[`examples/aircon/core-ts/page.ts`](../../examples/aircon/core-ts/page.ts) is a page with WebMCP tools, and `examples/aircon/test/webmcp-page.test.ts` tests it in Chromium with a test host. `acid-cat conform --webmcp <url>` tests the binding against a page that serves the conformance fixture.

### Context per request

`mcpHandler` and `httpHandler` take either `context` or `createContext`. With `context`, all requests share one context. With `createContext(request)`, the handler makes a new context for each request that passes screening. Use it when a request must not reuse objects from an earlier request, as on Cloudflare Workers, or when callers must not share a stateful service. If the context has `Symbol.asyncDispose` or `Symbol.dispose`, the handler calls it after the response:

```ts
const handler = httpHandler(aircon, {
  allowedOrigins: [],
  toJsonSchema,
  createContext: () => ({ unit: connectUnit(env), [Symbol.asyncDispose]: () => disconnectUnit() }),
});
```

`createContext` can refuse a request by returning `refuse(status, message, headers?)` instead of a context. Use this to authenticate the caller, and pass the caller to the capabilities in the context:

```ts
import { httpHandler, refuse } from "@acid-cat/core-ts";

const handler = httpHandler(aircon, {
  allowedOrigins: [],
  toJsonSchema,
  createContext: async (request) => {
    const caller = await accounts.caller(request.headers.get("Authorization"));
    if (caller === undefined) return refuse(401, "Give a valid token.", { "WWW-Authenticate": "Bearer" });
    return { unit, caller };
  },
});
```

- A refusal answers with its status and headers, the media type `application/json`, and the body `{ "message" }`. The handler opens no session, so no capability runs and no subscription starts. Keep internal data out of the message.
- A refusal's status is an integer from 400 to 599. `refuse` throws a `RangeError` for any other status.
- `isRefusal(value)` tells whether a value is a refusal made by `refuse`.
- The handler releases the context after the response, or when a subscription's stream ends.
- Over MCP, a poll lease or webhook subscription uses the context of the request that started it. The handler calls `createContext` once per request, and releases the context when the response is done and every lease and webhook subscription from that request has ended.
- Also set the `principal` option of `mcpHandler`, from the same caller. Poll leases are keyed by principal, event and input. Without a principal, two callers that poll the same event with the same input share one lease, and the second caller reads occurrences from the first caller's session.
- The command line and MCP over stdio have one context for the whole program.

### Command line

The command line has one command per capability in the `cli` target's view. The words of the id make the command path: `aircon.temperature.set` is `aircon temperature set`.

Each top-level input property is a flag of the same name:

| Property type | Flag |
| --- | --- |
| String, number or string enum | The value: `--celsius 22` or `--celsius=22` |
| Boolean | A switch: `--on` |
| Array of strings, numbers or string-enum values | A repeated flag. Each occurrence adds one item, in order. A single occurrence can also give the whole array as JSON text |
| Anything else | JSON text |

A shared prefix holds only other commands. If one capability's path starts another's, such as `aircon.status` and `aircon.status.get`, `runCli` rejects and `cliMain` stops the program with an error at startup.

With the air conditioner's command line, [`examples/aircon/core-ts/cli.ts`](../../examples/aircon/core-ts/cli.ts):

```sh
node cli.ts aircon temperature set --celsius 22
node cli.ts aircon schedule set --days mon --days fri --hours 7 --hours 18   # {"days":["mon","fri"],"hours":[7,18]}
node cli.ts aircon schedule set --days '["mon","fri"]' --hours '[7,18]'      # the same input, as JSON text
node cli.ts aircon schedule set --days '[]'                                   # an empty array
node cli.ts list                                                             # the usage of each command
node cli.ts aircon power set --help                                          # Usage: aircon aircon power set --on, then the description
node cli.ts aircon status --help                                             # Commands:, then the usage of each command under aircon status
```

- `list` prints a usage line for each capability, then each event. Each item has `kind`: `"capability"` or `"event"`. A repeated flag's usage ends with `...`, for example `--days <mon|tue|wed|thu|fri|sat|sun>... [--hours <integer>...]`.
- `--help` after a command path prints `Usage: ` and the usage, an empty line, and the description. `<alias> --help` and `watch <id> --help` do the same for an alias and an event.
- `--help` after a shared prefix prints `Commands:` and the usage of each command under it, in `list` order. A shared prefix alone, or followed by arguments that are neither `--help` nor a command path, prints the same list to standard error and exits with 2.

See the [CLI binding](../../spec/bindings/cli.md#commands) for the full rules.

#### Watch events

`watch <id>` subscribes to an event. Its flags come from the input schema, with the same rules as for a capability. If the input schema has no top-level `properties` member, `watch <id> '<json>'` takes the input as JSON text. Each occurrence goes to standard output as one line of JSON, with its cursor.

`--cursor <cursor>` and `--max-age-ms <integer>` resume after a cursor, in both the flag form and the JSON form. A script can keep the last cursor and resume from it after the program stops. A `--max-age-ms` that is not a whole number exits with 3. These two flags are not input properties: if an event's input schema has a top-level `cursor` or `max-age-ms` property, `runCli` throws at startup.

```sh
node cli.ts watch aircon.status.changed
node cli.ts watch aircon.status.changed --cursor 41 --max-age-ms 300000
```

| Exit code | When |
| --- | --- |
| 0 | The subscription is complete |
| 130 | After an interrupt (`SIGINT`) |
| 5 | After `internal`, with `{ "kind", "message" }` on standard error |
| Same as a call | A failure before the first occurrence |

#### Interrupts and startup errors

In `cliMain`, an interrupt (`SIGINT`) cancels the call or the subscription. A capability that cannot stop, such as one waiting on a dynamic `import()`, does not keep the process alive: if the call or subscription has not ended one second after the interrupt (`INTERRUPT_GRACE_MS` from `@acid-cat/spec-ts`), the process exits with 130 and writes nothing more. A second interrupt exits with 130 at once.

When the command line breaks a binding rule, for example with two commands on the same path, `cliMain` writes the message to standard error and exits with 5 (`internal`).

### Application commands

The `commands` option of `cliMain` and `runCli` adds your own commands beside the capability commands, `call`, `list` and `watch`. A command has a `name`, a `description` for the help, and `run(args, io)`. `run` gets the arguments after the command name, plus `io` with `stdout`, `stderr`, `signal` and the `context`, and returns the exit code.

`runCli` throws if the name is `call`, `list`, `watch`, another application command's name, or the first word of a capability's command. The name also must not be the first word of a command alias.

The `description` option sets the text at the top of the help. The default is the application's description, then its title, then the program name.

```ts
import { cliMain } from "@acid-cat/core-ts";
import type { CliCommand } from "@acid-cat/core-ts";

const report: CliCommand<{ unit: Unit }> = {
  name: "report",
  description: "Write the temperature of the room.",
  run: (_args, { context, stdout }) => {
    stdout(`The room is at ${context.unit.state.roomCelsius} °C.`);
    return 0;
  },
};

cliMain(aircon, { name: "aircon", version: "0.1.0", context: { unit }, toJsonSchema, description: "Control the air conditioner.", commands: [report] });
```

#### Aliases

The `cli` target can declare [aliases](../../spec/bindings/cli.md#aliases) in its `cli` member: short names for capabilities or events, with an optional fixed input. A command alias is one or two words. A flag alias is `--` and one word. `cliAlias` takes the capability or event, and the fixed input's type comes from its input schema. The catalog writes the aliases in `options.cli`.

```ts
targets: {
  cli: {
    bindings: ["cli"],
    cli: {
      aliases: {
        status: cliAlias(statusGet),
        "--on": cliAlias(powerSet, { on: true }),
        "--off": cliAlias(powerSet, { on: false }),
        fan: cliAlias(fanSet),
        "fan high": cliAlias(fanSet, { speed: "high" }),
      },
    },
  },
},
```

```sh
node cli.ts --on      # same as: node cli.ts aircon power set --on
node cli.ts status    # same as: node cli.ts aircon status get
node cli.ts fan high  # same as: node cli.ts aircon fan set --speed high
node cli.ts fan --speed low
```

- Properties in the fixed input are not flags of the alias. The other properties are flags, with the usual rules.
- `list` shows each capability's and event's alias usages in `aliases`, and the help lists them.
- An alias for an event works like `watch`: `follow: cliAlias(statusChanged)` makes `node cli.ts follow` equal to `node cli.ts watch aircon.status.changed`, with `--cursor` and `--max-age-ms`.
- `cliAliasDefault(statusGet)` makes the default alias. `node cli.ts` with no arguments runs it, and so does a first flag that is not a flag alias, such as `node cli.ts --flag`. `--help` still prints the help.
- If an alias breaks a rule, `runCli` rejects and `cliMain` stops the program with an error at startup.

Two-word aliases and shared prefixes:

- Command aliases with the same first word form a group, such as `fan` and `fan high`. If the first two arguments name a two-word alias, it runs. Otherwise the one-word alias runs with the remaining arguments. A second argument that is a word but not the second word of an alias in the group, such as `node cli.ts fan medium`, is an unknown command with exit code 2.
- A command alias can be named after a shared prefix, but not after a command path. It then becomes the prefix's default: `"aircon power": cliAlias(powerSet)` makes `node cli.ts aircon power --on` call `aircon.power.set`, while `node cli.ts aircon power set --on` stays the `aircon.power.set` command. A word after a prefix default that names no command, such as `node cli.ts aircon power nope`, is an unknown command with exit code 2.

#### Human output

The command line writes JSON for programs. It can also write a human form. Without the `output` option, it writes JSON only, even on a terminal, and accepts no output flag.

To enable the human form, pass the `output` option to `cliMain` or `runCli`:

- `flags`: the output flags. Each has `names`: `--word`, or `-x` with one letter or digit.
  - A switch has `form`, `"human"` or `"json"`: `{ names: ["--json"], form: "json" }`.
  - A flag with a value has `values`, which maps each value to a form: `{ names: ["--format", "-f"], values: { text: "human", json: "json" } }` accepts `--format text`, `--format=text` and `-f text`.
  - An output flag can appear anywhere in the arguments before a later `--`. The command line ignores a leading `--`, which package runners such as `pnpm` and `npx` pass. For an application command, the output flag must come before the command name: the command gets the arguments after its name unchanged, and `io.output` holds the chosen form.
  - If the arguments give more than one output flag, the last one wins. A missing or unknown value is a usage error with exit code 3: `The option --format must be json or text.`
- `default`: the form when no output flag is given, `"json"` (the default) or `"auto"`. With `"json"`, the output is JSON unless an output flag picks the human form. With `"auto"`, `cliMain` writes the human form when standard output is a terminal, `CI` is not set, and no coding agent is detected; otherwise JSON. `runCli` takes the form from `io.output`, which defaults to `"json"`.
- `formats`: the formatters for the human form (see below).

These environment variables signal a coding agent: `AI_AGENT`, `CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_AGENT`, `GEMINI_CLI`, `OPENCODE`, `AMP_CURRENT_THREAD_ID`, `AUGMENT_AGENT`, `QWEN_CODE_SESSION_ID`, `PI_CODING_AGENT`, `CRUSH` and `COPILOT_AGENT`. A variable counts as set unless its value is empty, `0`, `false`, `no` or `off`.

The help lists output flags under `Output:`. An output flag may be named `-h`: then `-h` picks its form and `--help` still prints the help. `runCli` rejects, and `cliMain` stops with an error at startup, if an output flag name is invalid, appears in two output flags, or collides with another flag: `--help`, `--version`, `--cursor`, `--max-age-ms`, a flag alias, or an input flag of a capability or event in the view. The human form uses colors only on a terminal, and only when `NO_COLOR` is not set.

Exit codes and output streams are the same in both forms, and help, usage and `--version` do not change. In the human form:

- A value goes through its capability's formatter, or the generic layout if there is none. A `null` value prints nothing.
- A failure goes through its tag's formatter, or the failure object gets the generic layout.
- A call failure goes to standard error as `error (<kind>): <message>`.
- `watch` prints one block per occurrence, using the event's formatter for `data` or the generic layout. Before an occurrence with `truncated: true`, it prints `(some occurrences were lost)`.
- `list` prints the capability and event commands with their descriptions.

The generic layout prints an object as one `key  value` line per scalar member, and `key:` with an indented block for other members. An array of scalars is one line, joined with `, `. An array of flat objects is a table. Any other array is a `- ` list.

`cliFormat` makes a formatter; pass formatters in `output.formats`. It takes the capability or event, and the types of the value, each failure and the payload come from their schemas. A formatter gets the value decoded from JSON with its schema, plus `ui`: `bold`, `dim`, `ok`, `warn` and `error` style text, and `table(header, rows)` prints a table. If the value does not decode or the formatter throws, the command line falls back to the generic layout. Two formats for one id, or a format for an id outside the view, make `runCli` reject at startup.

```ts
import { cliFormat, cliMain } from "@acid-cat/core-ts";
import type { CliUi } from "@acid-cat/core-ts";

const statusText = (status: z.infer<typeof Status>, ui: CliUi) => `${ui.bold(status.power ? "on" : "off")} · ${status.mode}`;

cliMain(aircon, {
  name: "aircon",
  version: "0.1.0",
  context: { unit },
  toJsonSchema,
  output: {
    flags: [
      { names: ["--format", "-f"], values: { text: "human", json: "json" } },
      { names: ["--json"], form: "json" },
    ],
    formats: [
      cliFormat(statusGet, { value: statusText, failures: { Offline: (_, ui) => ui.error("offline") } }),
      cliFormat(statusChanged, statusText),
    ],
  },
});
```

```sh
node cli.ts aircon status get --format text   # off · cool
node cli.ts aircon status get --json          # {"power":false,"mode":"cool",…}
```

### Remote command line

The command line can drive a view of an application that runs on a server ([Server](../../spec/bindings/cli.md#server)). Pass `remote` to `cliMain` or `runCli`, with a client for the server's HTTP binding: `httpClient(url, { headers?, fetch? })`. Commands, flags and help still come from the view in the local program.

| Command | Request |
| --- | --- |
| A capability call | `POST {url}/capabilities/{id}` |
| `list` | `GET {url}/capabilities`, for availability |
| `watch` | `POST {url}/events/{id}`, with the cursor in `Last-Event-ID` and `maxAgeMs` in the query |

- A capability the server does not list shows as unavailable in `list`.
- A server that does not answer gives the call failure `unavailable`, with exit code 4. A response the HTTP binding does not define gives `internal`, with exit code 5.
- An interrupt (`SIGINT`) closes the request, so the server cancels the call or subscription. The exit code is 130.
- The client sends `headers` with each request, such as a token in `Authorization`. The command line never prints them.
- `httpClient` throws if the URL is not `http` or `https`, if it has a user name, password, query or fragment, or if a header is invalid. The error never contains a header value.

Serve the HTTP binding with the command line's target, so both have the same view. [`examples/aircon/core-ts/serve.ts`](../../examples/aircon/core-ts/serve.ts) serves it, and [`examples/aircon/core-ts/cli.ts`](../../examples/aircon/core-ts/cli.ts) sends to it when `AIRCON_URL` is set:

```ts
// On the server.
serve({ "/cli": httpHandler(aircon, { allowedOrigins: [], target: "cli", base: "/cli", context: { unit }, toJsonSchema }) }, { hostname: "0.0.0.0", port: 8080 });

// In the command line.
cliMain(aircon, { name: "aircon", version: "0.1.0", context: { unit: new Unit() }, toJsonSchema, remote: httpClient("http://pi.local:8080/cli", { headers: { Authorization: `Bearer ${token}` } }) });
```

The client also works on its own: `capabilities()`, `invoke(id, input, { signal })` and `subscribe(id, input, { signal, cursor, maxAgeMs })`. No method rejects; each returns the call failure instead.

## Examples and tests

- [`examples/aircon/core-ts`](../../examples/aircon/README.md) is an air conditioner built with this package, including its command line. [`examples/aircon/apis`](../../examples/aircon/README.md#apis) builds GraphQL, Cap'n Web and Elysia APIs on it, each beside the HTTP binding.
- `moon run core-ts:test` tests sessions, handles and every binding with test applications, and runs `acid-cat conform` against every binding. The test applications are in `test/`:
  - [`test/fixture.ts`](test/fixture.ts) has one capability for each behavior that `acid-cat conform` tests.
  - [`test/kettle.ts`](test/kettle.ts) is an in-memory electric kettle. Its tests cover the catalog the core writes, named types, state, availability, typed handles and the command line.
  - [`test/sensors.ts`](test/sensors.ts) is a set of in-memory temperature sensors. Its tests cover events through each binding: occurrences, how subscriptions end, slow clients, cursors, and a GraphQL subscription with graphql-js.
