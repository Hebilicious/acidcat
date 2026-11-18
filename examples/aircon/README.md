# Air conditioner

A simulated air conditioner, described once in a catalog and served to every surface: a command line, MCP servers, a web page with WebMCP tools, and four hand-written APIs. The unit lives in memory, so you can run everything without hardware.

The same application exists on all three cores, so you can compare how each core expresses it:

| Directory | Contents |
| --- | --- |
| [`catalog/`](catalog) | The catalog, written in Pkl, TypeScript, Python, Go and Rust. Each language writes the same bytes. |
| [`core-ts/`](core-ts) | The application on [`@acid-cat/core-ts`](../../packages/core-ts), with Zod: command line (`cli.ts`), MCP server through stdio (`mcp-stdio.ts`), server for a remote command line (`serve.ts`), and web page with WebMCP tools (`page.ts`, `serve-page.ts`). |
| [`core-effect/`](core-effect) | The same application on [`@acid-cat/core-effect`](../../packages/core-effect), written entirely in Effect, with the same files. |
| [`core-rust/`](core-rust) | The application on [`acid-cat-core`](../../packages/core-rust), as one Rust program: command line (`aircon cli`), MCP server through stdio (`aircon mcp-stdio`), and server for a remote command line (`aircon serve`). |
| [`web/`](web) | The page markup and controls that both TypeScript cores use. |
| [`apis/`](apis) | APIs whose design the application controls: GraphQL, Cap'n Web, Elysia and an MCP server. |
| [`test/`](test) | The tests for every part. |

The example imports the packages by name, for example `@acid-cat/core-ts`. The packages never import the example.

Run every command below from `examples/aircon` unless it says otherwise. Build the Rust program once with `cargo build --manifest-path core-rust/Cargo.toml` before you use `core-rust/target/debug/aircon`.

## The catalog

[`catalog/aircon.pkl`](catalog/aircon.pkl) is the source. `moon run examples` writes it in canonical form to [`catalog/aircon.acidcat.json`](catalog/aircon.acidcat.json).

Each catalog library also writes the same catalog from its own language: [`typescript.ts`](catalog/typescript.ts), [`python.py`](catalog/python.py), [`go/main.go`](catalog/go/main.go) and [`rust/src/main.rs`](catalog/rust/src/main.rs). Each program prints the catalog, and the test checks that every output is exactly `aircon.acidcat.json`. Each application's test also compares the catalog it serves with that file.

## The command line

Each core gives the application a command line, with one command for each capability in the view of the `cli` target:

```sh
node core-ts/cli.ts aircon power set --on
node core-effect/cli.ts aircon mode set --mode heat
node core-ts/cli.ts aircon schedule set --days mon --days fri --hours 7 --hours 18
node core-ts/cli.ts list
node core-ts/cli.ts aircon status get --output human
node core-effect/cli.ts status --json
cargo run --manifest-path core-rust/Cargo.toml -- cli aircon fan set --speed high
node core-ts/cli.ts aircon power set --help
node core-effect/cli.ts aircon status --help
```

What to look at:

- **Shared types.** A flag of a shared type, such as `--mode`, accepts only that type's values.
- **Repeated flags.** `aircon.schedule.set` takes two arrays: `days`, with items of the shared type `Day`, and `hours`, with integers. Each one is a repeated flag, and each occurrence adds one item in order, so the command above sets the days `["mon", "fri"]` and the hours `[7, 18]`. A repeated flag given once can also carry the whole array as JSON: `--days '["mon","fri"]'` gives the same days. In the usage that `list` prints, a repeated flag ends with `...`:

  ```
  aircon aircon schedule set --days <mon|tue|wed|thu|fri|sat|sun>... [--hours <integer>...]
  ```

- **Help.** `aircon power set --help` prints `Usage: aircon aircon power set --on`, an empty line, and the capability's description. `aircon status --help` prints `Commands:` followed by the usage of `aircon.status.get` and `aircon.status.export`. `aircon status` on its own, or with arguments that are neither `--help` nor a command path (such as `aircon status --path out.json`), prints the same list to standard error and exits with code 2. Each core's test checks this help.
- **Interrupts.** `SIGINT` (Ctrl+C) cancels the call or the subscription, for example `follow`, and the exit code is 130. If a call cannot stop, the command line still exits with 130 one second after the interrupt, or at once on a second interrupt.

### Human or JSON output

The cores leave the human form off by default. Each command line in this example turns it on by setting the default form to `auto`. With `auto`, the command line writes text for a person when it runs in a terminal. `aircon status get` then gives:

```
off · cool · fan auto · target 22°C · room 25°C
```

In a pipe, in CI, or under a coding agent, the output is JSON. Without `auto`, the output is JSON unless an output flag asks for the human form. The output flags work anywhere in the arguments: `--output human`, `--output json`, `--output=human`, `-o human` and `--json`.

Each core formats the status, the `Offline` failure of `aircon.status.get`, and the payload of `aircon.status.changed`. Other values use the generic layout.

### Aliases

The `cli` target defines eight [aliases](../../spec/bindings/cli.md#aliases) in `options.cli`. Each core builds them from the capability and event objects.

| Alias | Runs |
| --- | --- |
| `status` | `aircon.status.get`. It is the default alias, so running the program with no arguments does the same. |
| `--on`, `--off` | `aircon.power.set` with the fixed input `{ "on": true }` or `{ "on": false }`. |
| `follow` | A subscription to `aircon.status.changed`, the same as `watch aircon.status.changed`. |
| `fan` | `aircon.fan.set` with the flag `--speed`. |
| `fan auto`, `fan high` | `aircon.fan.set` with the fixed input `{ "speed": "auto" }` or `{ "speed": "high" }`. `fan medium` is an unknown command, because no alias has that name. |
| `aircon power` | `aircon.power.set` with the flag `--on`. It is the default of the shared prefix `aircon power`, and the command `aircon power set` keeps its path. `aircon power nope` is an unknown command, because no command under `aircon power` is named `nope`. |

```sh
node core-ts/cli.ts --on
node core-effect/cli.ts status
node core-ts/cli.ts                  # the default alias: the same as status
node core-ts/cli.ts follow           # the same as watch aircon.status.changed
node core-effect/cli.ts fan high     # the same as aircon fan set --speed high
node core-ts/cli.ts fan --speed low
node core-ts/cli.ts aircon power --on # the same as aircon power set --on
cargo run --manifest-path core-rust/Cargo.toml -- cli --off
```

### Control a unit in another process

Each core can serve the HTTP binding of the `cli` target. The server prints its URL. Set `AIRCON_URL` and the command line sends every call and subscription to that server instead of a local unit. Each server runs until you stop it, so start each one in its own terminal:

```sh
node core-ts/serve.ts 0.0.0.0:8080
node core-effect/serve.ts 0.0.0.0:8081
core-rust/target/debug/aircon serve 0.0.0.0:8082
AIRCON_URL=http://localhost:8080/cli node core-ts/cli.ts aircon power set --on
AIRCON_URL=http://localhost:8081/cli node core-effect/cli.ts aircon power set --on
AIRCON_URL=http://localhost:8082/cli core-rust/target/debug/aircon cli aircon power set --on
```

### Command line only

`aircon.status.export` writes the status to a file. Its audience is only `cli`, because only the command line gives its sessions the file system:

```sh
node core-ts/cli.ts aircon status export --path status.json
```

The MCP servers, WebMCP and the APIs do not have it, and fail with `unknown-capability`. The remote command-line server is the exception: it serves the `cli` target, and fails with `WriteFailed`.

## MCP server through stdio

Each application has an MCP server through [stdio](../../spec/bindings/mcp.md#stdio), for MCP clients that start a local process. It serves the view of the `mcp` target. Give your MCP client one of these commands, with the repository root as its working directory:

```sh
node examples/aircon/core-ts/mcp-stdio.ts
node examples/aircon/core-effect/mcp-stdio.ts
examples/aircon/core-rust/target/debug/aircon mcp-stdio
```

The task `example-aircon:test-rust` builds the Rust program and runs its tests before the other tests.

The process is one session with one simulated unit, and it exits when standard input ends.

Look at the tool annotations. The capabilities that change a setting, such as `aircon.power.set` and `aircon.schedule.set`, have the [hints](../../spec/catalog.md#capabilities) `destructive: true` and `idempotent: true`: a call overwrites the old setting, and repeating it with the same input changes nothing more. `aircon.status.get` is `readOnly`. Each MCP server turns these hints into `destructiveHint`, `idempotentHint` and `readOnlyHint`.

## WebMCP

Each TypeScript core has a web page for the `app` target, the target for apps that people use. It has the [WebMCP binding](../../spec/bindings/webmcp.md). The page shows the unit's status and has controls for power, mode, target temperature, fan speed and firmware update. A check box takes the simulated unit offline and back online.

| Page | Session | WebMCP |
| --- | --- | --- |
| [`core-ts/page.ts`](core-ts/page.ts) | `createSession(aircon, { target: "app", … })` | `installWebMcp(session)` |
| [`core-effect/page.ts`](core-effect/page.ts) | `Session.make(aircon, { target: "app" })`, in one Effect program | `WebMcp.install(session)` |

Both pages use the markup in [`web/page.ts`](web/page.ts) and the controls in [`web/controls.ts`](web/controls.ts). Each page has its own simulated unit. To serve one, run:

```sh
node core-ts/serve-page.ts
node core-effect/serve-page.ts
```

The script bundles the page with esbuild, serves it on `127.0.0.1` on a free port, and prints the URL. Pass an address, such as `127.0.0.1:8080`, to choose the port.

Open the URL in a browser with WebMCP. The page uses `document.modelContext`, or `navigator.modelContext` if the first does not exist. Without WebMCP, the controls still work and the WebMCP status reads `no host`.

A browser agent gets one tool for each capability in the view of the `app` target. What to look at:

- **Names and schemas.** Each tool's name is the capability id, such as `aircon.temperature.set`, and its description is the capability's description. The input schema is bundled: `aircon.mode.set` has the type `Mode` in its `$defs`.
- **Outcomes.** A call resolves with the result in JSON form: `{ "ok": true, "value": null }`, or a failure such as `{ "ok": false, "error": { "_tag": "Offline" } }`. A call failure rejects with an `Error` that has a `kind`, for example `invalid-input` for a temperature of 40.
- **Availability.** `aircon.firmware.update` is available only while the unit is online. When the unit goes offline, the page removes the tool. When it comes back, the page registers the tool again. The page lists every capability and whether it is available.
- **One session.** The controls and the tools call the same session. The page shows each change an agent makes, and the agent reads each change a person makes.
- **Binding status.** The page shows it: `loading`, `reconciling`, `ready`, `failed`, `closing` or `disposed`. In core-ts this is the installation's `status`. In core-effect it is the installation's `status` ref.

The Rust core has no WebMCP, because WebMCP runs in a web page and the Rust program runs as a process. Its catalog still puts the WebMCP binding on the `app` target, so the catalog is the same in every language.

[`test/webmcp-page.test.ts`](test/webmcp-page.test.ts) opens each page in Chromium through Playwright, with a test WebMCP host as its `modelContext`. It reads the tools, calls them, and checks what the page shows.

## APIs

The HTTP and MCP bindings give generic access: one route or one tool for each capability id. When you want an API with your own design, write it as application code on a session, with any library, and serve a binding beside it.

| File | Library | API | Failures |
| --- | --- | --- | --- |
| [`apis/graphql.ts`](apis/graphql.ts) | [Pothos](https://pothos-graphql.dev), [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) and [graphql-ws](https://the-guild.dev/graphql/ws) | `query { status }`, mutations that return the new status, and `subscription { statusChanged }`, which follows `aircon.status.changed` through server-sent events (Yoga, with the graphql-sse client) and WebSockets (graphql-ws on a [`ws`](https://github.com/websockets/ws) server). Schema: [`apis/schema.graphql`](apis/schema.graphql). | Data: each field returns a union of `Status` and its capability's failures, for example `Status \| Offline \| PoweredOff` |
| [`apis/capnweb.ts`](apis/capnweb.ts) | [Cap'n Web](https://github.com/cloudflare/capnweb) | A class with typed methods. A client sends many calls in one HTTP request, or calls them over time through WebSockets ([`ws`](https://github.com/websockets/ws)). `followStatus(listener)` follows `aircon.status.changed` through WebSockets: the server calls the client's function with each new status until the client disposes the result. | A result value: `{ ok: false, error }` |
| [`apis/elysia.ts`](apis/elysia.ts) | [Elysia](https://elysiajs.com) | `GET /status`, `PATCH /status` (which changes several settings), `GET /status/changes` (a server-sent event stream from a generator route with `sse`), and the WebSocket `/status/follow`. Both streams follow `aircon.status.changed`. The WebSocket runs on Elysia's Node.js adapter, `@elysiajs/node`. The HTTP binding is mounted with `.mount("/api", …)`. | Status 409 with the failure |
| [`apis/mcp.ts`](apis/mcp.ts) | [Effect](https://effect.website) `effect/ai` | MCP tools at `/mcp`: `get_status`, with `readOnlyHint`, and `set_controls`, which changes several settings in one call, with `destructiveHint` and `idempotentHint`. The same URL serves `aircon.status.changed` through the [MCP events extension](../../spec/bindings/mcp.md#events), with push and poll delivery: `Mcp.withEvents` from `@acid-cat/core-effect` wraps the `effect/ai` server. | A tool error with the failure |

The first three APIs use the `@acid-cat/core-ts` application and serve the HTTP binding at `/api`. [`apis/shared.ts`](apis/shared.ts) holds the code they share. The MCP API uses the `@acid-cat/core-effect` application and serves the MCP binding at two URLs:

| URL | MCP revisions | Use |
| --- | --- | --- |
| `/capabilities/mcp` | `2026-07-28` | `Mcp.toWebHandler(…)`. Use this form when your clients support revision `2026-07-28`. |
| `/capabilities/mcp-legacy` | `2026-07-28`, plus the [`initialize` handshake](../../spec/bindings/mcp.md#earlier-revisions-through-http) of `2025-11-25` and `2025-06-18` | `Mcp.withHandshake(Mcp.toWebHandler(…))`, for clients that still open the session with `initialize`. This form keeps no session, so it does not send `notifications/tools/list_changed` to these clients. |

Every API rejects origins it does not allow.

### How the APIs use sessions

Each API calls the capabilities through a session, so it gets the same outcomes as every other surface.

- **One session per client.** A session serves one client (see [Sessions](../../spec/invocation.md#sessions)). Each request, or each Cap'n Web batch, opens its own session with `await using session = openSession(options)`, and the session closes when the block ends. A GraphQL or Cap'n Web WebSocket connection is one session. The unit is a service in the context, so all sessions share it.
- **Typed calls.** API input is untrusted. `session.call(powerSet, input)` checks it against the capability's input schema and returns a result typed by the capability, with no cast. The MCP API checks its tool parameters with Effect Schema, then calls the `@acid-cat/core-effect` session.
- **Three outcomes.** A value and a failure are results, and each API gives them in its own form: data, a union member, or a status code. A call failure rejects as a `CallFailureError`, and each API turns it into an error of its protocol.
- **Subscriptions.** Each API follows the event with `session.eventHandle(statusChanged).subscribe(…)` and stops the subscription when its client stops or goes away. A server-sent event request keeps its session open until the stream ends. A WebSocket connection opens its session on connect and closes it on disconnect, which ends every subscription on that connection.

How each API ends a subscription:

- GraphQL: The `subscribe` resolver of `statusChanged` returns the promise from `subscribe`, and its `resolve` gives the data of each occurrence. GraphQL calls the iterator's `return()` when the client ends the subscription.
- Cap'n Web: `followStatus` subscribes with a signal and calls the client's listener with each occurrence. It returns a `Following` object. The signal aborts when the client disposes that object, when the connection breaks, or when the listener throws.
- Elysia: The generator of `GET /status/changes` subscribes with the request's signal, which aborts when the client goes away. Its first event, `retry: 1000`, makes Elysia send the response before the first change. Each change is an `aircon.status.changed` event with the status as its data. The WebSocket `/status/follow` is one session per connection: it sends `{ "event": "following" }` when the subscription starts, then `{ "event": "aircon.status.changed", "data": <status> }` for each change. Closing the WebSocket cancels the subscription. An upgrade request from a foreign origin gets 403.
- MCP: The `effect/ai` server cannot add methods, so `Mcp.withEvents(aircon, unit, application.handler, options)` takes each events-extension request before the `effect/ai` server sees it, and answers it the way the MCP binding does. The server declares the extension with `extensions: Mcp.eventsExtensions`. `events/stream` follows the event until the client closes the request. `events/poll` reads from a lease, which ends when `dispose` runs or after five minutes with no poll.

### Run an API

```sh
node apis/main.ts graphql   # or capnweb, elysia, mcp
```

`apis/main.ts` serves the API on `http://127.0.0.1:3000` with `serve` from `@acid-cat/core-ts/node`. The GraphQL API also serves WebSockets on `ws://127.0.0.1:3001/graphql`, and the Cap'n Web API on `ws://127.0.0.1:3001/rpc`. The Elysia API runs on `@elysiajs/node` instead, which serves its routes and its WebSocket `ws://127.0.0.1:3000/status/follow` on one port.

To watch status changes, start an API, follow the event in one terminal, and change the unit in another:

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

## Run the tests

```sh
moon run example-aircon:test
```

The tests start each TypeScript program of the example as a process from its bundle. The task `example-aircon:test-programs` writes the bundles into `.out/programs/` before the tests, because a bundle starts in less time than its source modules.

The tests run the Python, Go and Rust programs in `catalog/`, so they need `python`, `go` and `cargo`. proto installs them from [`.prototools`](../../.prototools). The web page tests need Chromium, which the task `cli:browser` installs before the tests run.
