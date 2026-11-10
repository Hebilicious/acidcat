# Air conditioner

One air conditioner, described once and served to every surface. The unit is simulated in memory. This example shows each part of AcidCat on the same application:

| Directory | Contents |
| --- | --- |
| [`catalog/`](catalog) | The catalog, written in Pkl, TypeScript, Python, Go and Rust. Each language gives the same bytes |
| [`core-ts/`](core-ts) | The application on [`@acid-cat/core-ts`](../../packages/core-ts), with Zod, its command line, and its MCP server through stdio |
| [`core-effect/`](core-effect) | The application on [`@acid-cat/core-effect`](../../packages/core-effect), fully in Effect, its command line, and its MCP server through stdio |
| [`apis/`](apis) | APIs whose design the application controls: GraphQL, Cap'n Web, Elysia and an MCP server |
| [`test/`](test) | The tests of all parts |

The example imports the packages by their names, for example `@acid-cat/core-ts`. The packages do not use the example.

## Catalog

[`catalog/aircon.pkl`](catalog/aircon.pkl) is the source of the catalog. [`catalog/aircon.acidcat.json`](catalog/aircon.acidcat.json) is the catalog in canonical form. `moon run examples` writes it from the Pkl source.

Each catalog library writes the same catalog in its own language: [`typescript.ts`](catalog/typescript.ts), [`python.py`](catalog/python.py), [`go/main.go`](catalog/go/main.go) and [`rust/src/main.rs`](catalog/rust/src/main.rs). Each program writes the catalog to its output. The test checks that each output is exactly `aircon.acidcat.json`.

## Application and command line

Both applications serve the catalog: the test of each one compares its catalog with `aircon.acidcat.json`. Each one has a command line:

```sh
node core-ts/cli.ts aircon power set --on
node core-effect/cli.ts aircon mode set --mode heat
node core-ts/cli.ts aircon schedule set --days mon --days fri --hours 7 --hours 18
node core-ts/cli.ts list
```

The command line has one command for each capability in the view of the `cli` target. A flag of a shared type, for example `--mode`, accepts only the values of that type.

The input of `aircon.schedule.set` has two arrays: `days`, with items of the shared type `Day`, and `hours`, with integer items. Each one is a repeated flag. Each occurrence of the flag gives one item, in the order of the flags, so the command above sets the days `["mon", "fri"]` and the hours `[7, 18]`. A repeated flag that occurs once can also give the whole array as JSON text: `--days '["mon","fri"]'` gives the same days. `list` gives the usage of each command. The usage of a repeated flag ends with `...`:

```
aircon aircon schedule set --days <mon|tue|wed|thu|fri|sat|sun>... [--hours <integer>...]
```

## MCP server through stdio

Each application also has an MCP server through [stdio](../../spec/bindings/mcp.md#stdio), for MCP clients that start a local process. It serves the view of the `mcp` target. For example, give an MCP client this command:

```sh
node examples/aircon/core-ts/mcp-stdio.ts
node examples/aircon/core-effect/mcp-stdio.ts
```

The process is one session with one simulated unit. When standard input ends, the process exits.

## APIs

The HTTP and MCP bindings give generic access to the capabilities: one route or one tool for each id. An API whose design you control is application code. Build it on a session, with the library that you prefer, and serve a binding beside it.

| File | Library | API | Failures |
| --- | --- | --- | --- |
| [`apis/graphql.ts`](apis/graphql.ts) | [Pothos](https://pothos-graphql.dev), [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) and [graphql-ws](https://the-guild.dev/graphql/ws) | `query { status }`, mutations that return the new status, and `subscription { statusChanged }`, which follows the event `aircon.status.changed`. The subscription works through server-sent events (Yoga, with the graphql-sse client) and through WebSockets (graphql-ws on a [`ws`](https://github.com/websockets/ws) server). The schema is in [`apis/schema.graphql`](apis/schema.graphql) | Data: each field returns a union of `Status` and the failures of its capability, for example `Status \| Offline \| PoweredOff` |
| [`apis/capnweb.ts`](apis/capnweb.ts) | [Cap'n Web](https://github.com/cloudflare/capnweb) | A class with typed methods. A client sends many calls in one request through HTTP, or calls them over time through WebSockets ([`ws`](https://github.com/websockets/ws)). `followStatus(listener)` follows the event `aircon.status.changed`: the server calls the function of the client with each new status, until the client disposes the result. It works through WebSockets | A result value: `{ ok: false, error }` |
| [`apis/elysia.ts`](apis/elysia.ts) | [Elysia](https://elysiajs.com) | `GET /status`, `PATCH /status` that changes many settings, `GET /status/changes`, a stream of server-sent events from a generator route with `sse`, and the WebSocket `/status/follow`. Both follow the event `aircon.status.changed`. The WebSocket runs on the Node.js adapter of Elysia, `@elysiajs/node`. The HTTP binding is mounted with `.mount("/api", …)` | Status 409 with the failure |
| [`apis/mcp.ts`](apis/mcp.ts) | [Effect](https://effect.website) `effect/ai` | MCP tools `get_status` and `set_controls`, which changes many settings in one call, at `/mcp`. The same URL serves the event `aircon.status.changed` through the [MCP events extension](../../spec/bindings/mcp.md#events), with push and poll delivery: `Mcp.withEvents` of `@acid-cat/core-effect` wraps the server of `effect/ai` | A tool error with the failure |

The first three APIs use the application on `@acid-cat/core-ts`, and serve the HTTP binding at `/api`. [`apis/shared.ts`](apis/shared.ts) has what they share. The MCP server uses the application on `@acid-cat/core-effect`, and serves the MCP binding at two URLs:

| URL | MCP revisions | Use |
| --- | --- | --- |
| `/capabilities/mcp` | `2026-07-28` | `Mcp.toWebHandler(…)`. Use this form when your clients support revision `2026-07-28` |
| `/capabilities/mcp-legacy` | `2026-07-28`, and the [`initialize` handshake](../../spec/bindings/mcp.md#earlier-revisions-through-http) of `2025-11-25` and `2025-06-18` | `Mcp.withHandshake(Mcp.toWebHandler(…))`, for clients that still open the session with `initialize`. This form keeps no session, so it does not send `notifications/tools/list_changed` to these clients |

All APIs reject origins that they do not allow.

Each API calls the capabilities through a session, so it gets the same outcomes as all other surfaces:

- **One session for each client.** A session serves one client (see [Sessions](../../spec/invocation.md#sessions)). Each request, or each Cap'n Web batch, opens its own session with `await using session = openSession(options)`. A WebSocket connection, of GraphQL or of Cap'n Web, is one session. The session closes when the block ends. The unit is a service in the context, so all sessions share it.
- **Typed calls.** An API gets input that is not trusted. `session.call(powerSet, input)` checks it with the input schema of the capability, and gives a result with the types of the capability, with no cast. The MCP server checks the parameters of its tools with Effect Schema, then calls the session of `@acid-cat/core-effect`.
- **Subscriptions.** Each API follows the event through `session.eventHandle(statusChanged).subscribe(…)`, and stops the subscription when its client stops or goes away. A request with a stream of server-sent events keeps its session open until the stream ends. A WebSocket connection opens its session when the client connects, and closes it when the connection closes, which ends each subscription of the connection.
  - GraphQL: the `subscribe` resolver of `statusChanged` returns the promise of `subscribe`, and its `resolve` gives the data of each occurrence. GraphQL calls `return()` of the iterator when the client ends the subscription.
  - Cap'n Web: `followStatus` subscribes with a signal, and calls the listener of the client with each occurrence. It returns a `Following` object. When the client disposes it, when the connection breaks, or when the listener throws, the signal aborts.
  - Elysia: the generator of `GET /status/changes` subscribes with the signal of the request, which aborts when the client goes away. Its first event, `retry: 1000`, makes Elysia send the response before the first change. Each change is an event `aircon.status.changed` with the status as its data. The WebSocket `/status/follow` is one session for each connection: it sends `{ "event": "following" }` when the subscription starts, then `{ "event": "aircon.status.changed", "data": <status> }` for each change. Closing the WebSocket cancels the subscription. A foreign origin gets 403 for the upgrade request.
  - MCP: the server of `effect/ai` has no way to add methods. So `Mcp.withEvents(aircon, unit, application.handler, options)` takes each request of the events extension before the server of `effect/ai` gets it, and answers it as the MCP binding does. The server declares the extension with `extensions: Mcp.eventsExtensions`. `events/stream` follows the event until the client closes the request. `events/poll` reads it from a lease, which ends when `dispose` runs or after five minutes with no poll.
- **Three outcomes.** A value and a failure are results: each API gives them in its own form, as data, as a union member, or as a status code. A call failure rejects as a `CallFailureError`, and each API turns it into an error of its protocol.

## Run

```sh
node apis/main.ts graphql   # or capnweb, elysia, mcp
moon run example-aircon:test
```

`apis/main.ts` serves the API on `http://127.0.0.1:3000`, with `serve` from `@acid-cat/core-ts/node`. The GraphQL API also serves WebSockets on `ws://127.0.0.1:3001/graphql`, and the Cap'n Web API on `ws://127.0.0.1:3001/rpc`. The Elysia API runs on `@elysiajs/node` instead, which serves its routes and its WebSocket `ws://127.0.0.1:3000/status/follow` on one port.

To follow the status, start an API, follow the event in one terminal, and change the unit in another:

```sh
# GraphQL, through server-sent events
curl -N http://127.0.0.1:3000/graphql -H 'Accept: text/event-stream' -H 'Content-Type: application/json' \
  -d '{"query":"subscription { statusChanged { power mode } }"}'
curl http://127.0.0.1:3000/graphql -H 'Content-Type: application/json' -d '{"query":"mutation { setPower(on: true) { __typename } }"}'

# Elysia, through server-sent events or a WebSocket
curl -N http://127.0.0.1:3000/status/changes
npx wscat -c ws://127.0.0.1:3000/status/follow
curl -X PATCH http://127.0.0.1:3000/status -H 'Content-Type: application/json' -d '{"power":true}'

# MCP, with events/stream of revision 2026-07-28
curl -N http://127.0.0.1:3000/mcp -H 'Accept: application/json, text/event-stream' -H 'Content-Type: application/json' \
  -H 'MCP-Protocol-Version: 2026-07-28' -H 'Mcp-Method: events/stream' -H 'Mcp-Name: aircon.status.changed' \
  -d '{"jsonrpc":"2.0","id":1,"method":"events/stream","params":{"name":"aircon.status.changed","arguments":{},"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

A Cap'n Web client follows the status through WebSockets:

```ts
import { newWebSocketRpcSession } from "capnweb";
import type { AirconApi } from "./apis/capnweb.ts";

using api = newWebSocketRpcSession<AirconApi>("ws://127.0.0.1:3001/rpc");
using following = await api.followStatus((status) => console.log(status));
await api.setPower(true);
```

The test runs the Python, Go and Rust programs of `catalog/`, so it needs `python`, `go` and `cargo`. proto installs them from [`.prototools`](../../.prototools).
