# @acid-cat/core-ts

Serve AcidCat capabilities and events in plain TypeScript. npm package: `@acid-cat/core-ts`.

This package has no Effect dependency. A capability returns a promise. An event gives an async iterable. Inputs are validated with any library that implements [Standard Schema](https://standardschema.dev), for example Zod, Valibot or ArkType. The application writes its own catalog.

```sh
pnpm add @acid-cat/core-ts
```

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

- `run` gets the input, an `AbortSignal` and the context. It returns `ok(value)` or `fail(failure)`, for example `fail({ _tag: "Offline", since })`. The types check that the value agrees with the output schema, that the failure has a tag of `failures`, and that it has the members of the schema of that tag. If `run` throws, the call fails as `internal`.
- With an input schema, `run` gets the output of the schema. With none, it gets an empty object.
- A failure schema describes the whole failure object, with its `_tag`.
- `availability` is an optional function that returns an observable availability. A session reads it with `getSnapshot` when a call comes in. It subscribes to it only while `onChange` or the handle has listeners.
- `state` is an optional `{ schema, source }`: the schema of the [state](../../spec/invocation.md#state), and a function that returns an observable. The handle gives it as `snapshot`.
- `capabilitiesFor<Context>()` sets the context type one time. The other types come from the schemas.
- `defineCapability` and `capabilitiesFor` keep the literal type of `id`, so that an application can type its ids. `run`, `availability` and `state` all get the same `Context`.
- An application lists only capabilities that `defineCapability` or `capabilitiesFor` made. Each one has `decode`, which validates an input that is not trusted with the input schema and then gives the call of `run`. A session calls it, because there the type of the input is not known.

## Write events

An [event](../../spec/events.md) is a kind of thing that happens, and that clients can follow. `subscribe` gives an async iterable, for example an async generator, with one value for each occurrence.

```ts
import { eventsFor } from "@acid-cat/core-ts";

const Status = z.object({ on: z.boolean(), celsius: z.number() }).meta({ id: "Status" });
const event = eventsFor<{ unit: Unit }>();

export const statusChanged = event({
  id: "aircon.status.changed",
  description: "The status of the unit changed. The occurrence gives the new status.",
  audience: ["app", "mcp"],
  input: z.object({}),
  payload: Status,
  async *subscribe(_input, { context, signal }) {
    for await (const status of context.unit.changes(signal)) yield { data: status };
  },
});

export const aircon = defineApp<{ unit: Unit }>({ targets, capabilities: [powerSet], events: [statusChanged] });
```

- `subscribe` gets the input, and `{ signal, context, cursor, maxAgeMs }`. The signal aborts when the subscription ends, in all ways. Stop the work and release the resources then.
- Each value is `{ data }`, and optionally `eventId`, `timestamp`, `cursor` and `truncated`. Give the `eventId` of the source if it has one. With none, the session makes a unique id. With no `timestamp`, the session uses the time at which it gets the value.
- `data` must agree with the payload schema. The session gives the client the output of the schema, as a copy. With no payload schema, `data` must be an empty object.
- If `subscribe` throws before it gives an iterable, the subscription fails as `internal` before it starts. If the iterable throws, or gives data that does not agree with the payload schema, the subscription ends with `internal`. The details go to `onDefect`, not to the client.
- When the iterable ends, the subscription is complete.
- The session asks for the first value before the promise of `subscribe` resolves. Thus the body of an async generator runs until its first `await` or `yield` before the client gets the iterable. Register a listener on the source before that point, and the subscription gets each change after `subscribe` resolves.
- To resume, give a `cursor` with each value. A client can give a `cursor` and `maxAgeMs` when it subscribes. Start after the cursor, and send no occurrence older than `maxAgeMs`. If you skip occurrences, give `truncated: true` on the first value. An event that gives no cursors ignores them.
- `defineEvent` and `eventsFor` keep the literal type of `id`. Capabilities and events share one set of ids.

## Write the catalog

```ts
import { renderCatalog } from "@acid-cat/core-ts";

const toJsonSchema = (schema) => z.toJSONSchema(schema, { target: "draft-2020-12" });
await writeFile("acidcat.catalog.json", renderCatalog(aircon, { toJsonSchema })); // canonical form
```

Standard Schema does not convert to JSON Schema. Give the converter of your schema library as `toJsonSchema`. The catalog has an `events` member when the application has events.

## Serve the capabilities and the events

| Function | Binding | Result |
| --- | --- | --- |
| `createSession(app, options)` | [TypeScript](../../spec/bindings/typescript.md) | A session with a handle for each capability and an event handle for each event in the view |
| `mcpHandler(app, options)` | [MCP](../../spec/bindings/mcp.md#http) through HTTP | `(request: Request) => Promise<Response>` |
| `mcpHandshake(handler)` | [MCP](../../spec/bindings/mcp.md#earlier-revisions-through-http) through HTTP, for earlier revisions | The handler, which also serves the `initialize` handshake of earlier revisions. From [`@acid-cat/mcp-handshake`](../mcp-handshake) |
| `mcpStdioMain(app, options)`, `runMcpStdio(…)` | [MCP](../../spec/bindings/mcp.md#stdio) through stdio | The MCP server of the process, or a promise that resolves when the input ends |
| `httpHandler(app, options)` | [HTTP](../../spec/bindings/http.md) | `(request: Request) => Promise<Response>` |
| `cliMain(app, options)`, `runCli(…)` | [CLI](../../spec/bindings/cli.md) | The command line of the process, or an exit code |
| `installWebMcp(session)` | [WebMCP](../../spec/bindings/webmcp.md) | Tools in the page, with a status. WebMCP serves no events |
| `serve(handler, options)`, from `@acid-cat/core-ts/node` | MCP and HTTP | A Node.js server for the web handlers. See [Serve on Node.js](#serve-on-nodejs) |

When the signal of a request aborts, `mcpHandler` and `httpHandler` cancel the call or the subscription of the request.

Each binding serves the events of its view:

| Binding | Events |
| --- | --- |
| TypeScript | `session.eventHandle(event).subscribe(input)`. See [Event handles](#event-handles) |
| HTTP | `GET {base}/events` lists them. `POST {base}/events/{id}` gives a stream of server-sent events: `event: next` for each occurrence, then `event: complete`, or `event: error` with `internal`. `Last-Event-ID` gives the cursor, and `?maxAgeMs=` gives `maxAgeMs`. The option `keepaliveMs` (15 seconds) sets the time after which an idle stream gets a comment line |
| MCP | The MCP events extension, revision `2026-07-28` only: `events/list` and `events/stream`, with push delivery. Through HTTP, the answer to `events/stream` is a stream of server-sent events. The option `heartbeatMs` (15 seconds) sets the time after which an idle stream gets `notifications/events/heartbeat`. A client with the `initialize` handshake gets no events |
| CLI | `watch <id>` writes each occurrence on one line. See [Command line](#command-line) |

The options `bufferLimit` of `createSession`, `httpHandler`, `mcpHandler` and `runMcpStdio` set the number of occurrences that each subscription keeps for a client that reads slowly. The default is 256. When the limit is full, the oldest occurrence goes, and the next occurrence that the client reads has `truncated: true`.

### Serve on Node.js

`@acid-cat/core-ts/node` serves web handlers on Node.js, with only `node:http`. It has no other dependency.

```ts
import { serve } from "@acid-cat/core-ts/node";

const mcp = mcpHandler(aircon, { name: "aircon", version: "1.0.0", allowedOrigins: [], toJsonSchema, context: { unit } });
const http = httpHandler(aircon, { allowedOrigins: [], toJsonSchema, context: { unit } });

const server = await serve({ "/mcp": mcp, "/": http }, { port: 3000 });
console.log(server.url); // http://127.0.0.1:3000
```

`serve(handler, options)` takes one handler for all paths, or handlers by path prefix. The longest prefix that matches gets the request, and the prefix `/` matches all paths. The MCP handler answers on all paths, so give it only its own prefix. A path that no prefix matches gets `404`. A handler that rejects gets `500`.

| Option | Default | Use |
| --- | --- | --- |
| `port` | `3000` | The port. With `0`, the system chooses a free port. `server.port` gives it |
| `hostname` | `127.0.0.1` | The address. Only the same computer can connect. Use `0.0.0.0` or `::` to accept connections from the network |

`serve` resolves when the server listens. `server.close()` stops it, and `await using server = await serve(…)` closes it at the end of the block. When a client closes its connection, the signal of its request aborts, so the handler cancels the call.

`serve` gives a plain HTTP/1.1 server. It does not serve HTTPS. When clients connect through a network, end TLS before the server, in the platform: a load balancer, the ingress of a Kubernetes cluster (for example with cert-manager for the certificates), or a tunnel such as Cloudflare Tunnel. The platform sends plain HTTP to the server on its private network. Set `hostname` to `0.0.0.0` or `::`, so that the platform can connect. Do not put a TLS proxy in the process in front of `serve`.

For more, use a library for web handlers, for example [srvx](https://srvx.h3.dev): HTTPS in the process, when TLS must reach the server, HTTP/2, middleware, or the same server code on Bun and Deno. Give it the handler. Make sure that the library aborts the signal of a request when the client closes the connection. If it does not, a closed connection does not cancel the call.

### MCP through stdio

An MCP client, for example a coding agent, can start the server as a local process. `mcpStdioMain` serves the standard input and output of the process. The process is one session, with one `context`. The server serves revision `2026-07-28`, and the `initialize` handshake of revisions `2025-11-25` and `2025-06-18`. When the availability of a capability changes, the server sends `notifications/tools/list_changed`. `notifications/cancelled` cancels a call or an `events/stream` request. When standard input ends, the session closes: the calls in progress are cancelled, and each subscription is complete.

```ts
#!/usr/bin/env node
import { mcpStdioMain } from "@acid-cat/core-ts";

mcpStdioMain(aircon, { name: "aircon", version: "1.0.0", context: { unit }, toJsonSchema });
```

Standard output carries only MCP messages. The session writes defects to standard error. Do not write to standard output from a capability. `runMcpStdio(app, options, { input, write })` is the same server on any stream: `input` is an async iterable of bytes or text, for example a `ReadableStream`, and `write` writes one line. It works in all runtimes.

### Typed calls and handles

`createSession` gives a `Session<Context>`. It calls a capability with the types of the capability in two ways. Both take the capability object, so the types come from its schemas:

- `session.call(capability, input)` takes an input that is not trusted, for example the arguments of a request. The input schema of the capability checks it. The result has the types of the capability. An input that does not agree rejects as `invalid-input`.
- `session.handle(capability)` gives the handle of the capability (spec/bindings/typescript.md#handles): its availability, its `snapshot` of the state, and `execute` for an input that the types already check.

Both call the capability through the session: availability, cancellation, and the checks of the output and of the failures. The session must serve that capability object. For any other capability, also one with the same id, a call rejects as `unknown-capability`, and the handle is always unavailable.

`session.handles` is the map of the handles by id, for bindings. A handle of the map has the input type `never`: call it with `invokeExternal`, which validates the input. A function that gets a session declares its context: `(session: Session<{ unit: Unit }>) => …`.

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

`session.eventHandle(event)` gives the event handle of an event (spec/bindings/typescript.md#event-handles), with the types of its schemas. `session.eventHandles` is the map of the event handles by id, for bindings. A handle of the map has the input type `never`: subscribe with `subscribeExternal`, which validates the input.

```ts
const status = session.eventHandle(statusChanged);
for await (const occurrence of await status.subscribe({})) {
  render(occurrence.data); // { on: boolean; celsius: number }
}
```

- The promise of `subscribe` resolves when the subscription has started. Before that, it rejects with a `CallFailureError`: `unknown-capability` for an event that the session does not serve, `invalid-input` for an input that does not agree with the schema, and `cancelled` when the session closes or the signal aborts.
- The result is an async iterator of occurrences: `eventId`, `name`, `timestamp`, `data`, and `cursor` and `truncated` if they are present. `return()` cancels the subscription, also while a `next()` waits: that `next()` resolves with `done: true`. `await using` also cancels it at the end of the block.
- The options are `signal`, `cursor` and `maxAgeMs`.
- When the session closes, each subscription is complete. With `internal`, `next()` rejects with a `CallFailureError`, then resolves with `done: true`.
- A session can hold any number of subscriptions at the same time. To cancel one does not change the others.

A GraphQL server can use an event handle as the source of a subscription. Return the promise of `subscribe` from the `subscribe` resolver of the field. GraphQL calls `return()` when the client ends the subscription, through WebSockets (graphql-ws) or server-sent events (graphql-sse, GraphQL Yoga):

```ts
subscription: { statusChanged: { subscribe: () => status.subscribe({}), resolve: (occurrence) => occurrence.data } }
```

### Context for each request

`mcpHandler` and `httpHandler` take `context` or `createContext`. With `context`, all requests share one context. With `createContext(request)`, the handler makes a new context for each request that passes the screening. Use it when a request must not use objects that an earlier request made, for example on Cloudflare Workers, or when a stateful service must not be shared between callers. When the context has `Symbol.asyncDispose` or `Symbol.dispose`, the handler calls it after the response:

```ts
const handler = httpHandler(aircon, {
  allowedOrigins: [],
  toJsonSchema,
  createContext: () => ({ unit: connectUnit(env), [Symbol.asyncDispose]: () => disconnectUnit() }),
});
```

### Command line

The command line has one command for each capability in the view of the `cli` target. Each top-level property of the input is a flag with the same name, for example `--celsius 22` or `--celsius=22`. A boolean property is a switch, for example `--on`. A property with an array of strings, numbers or values of a string enum is a repeated flag: each occurrence gives one item, in the order of the flags. A repeated flag that occurs once can also give the whole array as JSON text. Other properties take JSON text. For example, with the command line of the air conditioner, [`examples/aircon/core-ts/cli.ts`](../../examples/aircon/core-ts/cli.ts):

```sh
node cli.ts aircon temperature set --celsius 22
node cli.ts aircon schedule set --days mon --days fri --hours 7 --hours 18   # {"days":["mon","fri"],"hours":[7,18]}
node cli.ts aircon schedule set --days '["mon","fri"]' --hours '[7,18]'      # the same input, as JSON text
node cli.ts aircon schedule set --days '[]'                                   # an empty array
node cli.ts list                                                             # the usage of each command
```

`list` gives a usage line for each capability, then for each event. Each item has `kind`: `"capability"` or `"event"`. The usage of a repeated flag ends with `...`, for example `--days <mon|tue|wed|thu|fri|sat|sun>... [--hours <integer>...]`. See the [CLI binding](../../spec/bindings/cli.md#commands) for all the rules.

`watch <id>` subscribes to an event. The flags come from the input schema, with the same rules as for a capability. If the input schema has no top-level `properties` member, `watch <id> '<json>'` takes the input as JSON text. Each occurrence goes to standard output as JSON on one line. The exit code is 0 when the subscription is complete, 130 after an interrupt (`SIGINT`), and 5 after `internal`, with `{ "kind", "message" }` on standard error. A failure before the first occurrence has the exit code of a call.

```sh
node cli.ts watch aircon.status.changed
```

### Commands of the application

The option `commands` of `cliMain` and `runCli` adds commands of the application beside the commands of the capabilities, `call`, `list` and `watch`. A command has a `name`, a `description` for the help, and `run(args, io)`. `run` gets the arguments after the name of the command, and `io` with `stdout`, `stderr`, `signal` and the `context`. It returns the exit code. The name must not be `call`, `list`, `watch`, the name of another command of the application, or the first word of the command of a capability. If it is, `runCli` throws. The option `description` gives the text at the top of the help. The default is the description of the application, then its title, then the name of the program.

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

## Examples and tests

- [`examples/aircon/core-ts`](../../examples/aircon/README.md) is an air conditioner written with this package, with its command line. [`examples/aircon/apis`](../../examples/aircon/README.md#apis) builds GraphQL, Cap'n Web and Elysia APIs on it, each beside the HTTP binding.
- `moon run core-ts:test` tests sessions, handles and all bindings with a test application, and runs `acid-cat conform` against all bindings. Each test application is in `test/`:
  - [`test/fixture.ts`](test/fixture.ts) has one capability for each behavior that `acid-cat conform` tests.
  - [`test/kettle.ts`](test/kettle.ts) is an electric kettle, simulated in memory. Its tests examine the catalog that the core writes, named types, state, availability, typed handles and the command line.
  - [`test/sensors.ts`](test/sensors.ts) is a set of temperature sensors, simulated in memory. Its tests examine events through each binding: occurrences, the ends of a subscription, slow clients, cursors, and a GraphQL subscription with graphql-js.
