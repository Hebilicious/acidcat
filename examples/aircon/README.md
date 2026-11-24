# Air conditioner

A simulated air conditioner, described once in a catalog and served to every surface: a command line, MCP servers, a web page with WebMCP tools, and four hand-written APIs. The unit lives in memory, so everything runs without hardware.

The same application exists on all three cores, so you can compare them:

| Directory | Contents |
| --- | --- |
| [`catalog/`](catalog) | The catalog, written in Pkl, TypeScript, Python, Go and Rust. Each language writes the same bytes. |
| [`core-ts/`](core-ts) | The application on [`@acid-cat/core-ts`](../../packages/core-ts), with Zod: command line (`cli.ts`), MCP server through stdio (`mcp-stdio.ts`), remote command-line server (`serve.ts`), and web page with WebMCP tools (`page.ts`, `serve-page.ts`). |
| [`core-effect/`](core-effect) | The same files on [`@acid-cat/core-effect`](../../packages/core-effect), written entirely in Effect. |
| [`core-rust/`](core-rust) | The application on [`acid-cat-core`](../../packages/core-rust), as one program: `aircon cli`, `aircon mcp-stdio` and `aircon serve`. |
| [`web/`](web) | The page markup and controls that both TypeScript cores use. |
| [`apis/`](apis) | Hand-written APIs: GraphQL, Cap'n Web, Elysia and an MCP server. |
| [`test/`](test) | The tests for every part. |

The example imports the packages by name. The packages never import the example.

Run the commands below from `examples/aircon` unless a section says otherwise. Build the Rust program once with `cargo build --manifest-path core-rust/Cargo.toml` before you use `core-rust/target/debug/aircon`.

## The catalog

[`catalog/aircon.pkl`](catalog/aircon.pkl) is the source. `moon run examples` writes it in canonical form to [`catalog/aircon.acidcat.json`](catalog/aircon.acidcat.json).

[`typescript.ts`](catalog/typescript.ts), [`python.py`](catalog/python.py), [`go/main.go`](catalog/go/main.go) and [`rust/src/main.rs`](catalog/rust/src/main.rs) write the same catalog with each catalog library. The tests check that each output, and the catalog each application serves, is exactly `aircon.acidcat.json`.

## The command line

Each core serves one command for each capability in the view of the `cli` target. The rules are in the [CLI binding](../../spec/bindings/cli.md#commands).

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

- `--mode` takes a shared type, so it accepts only that type's values.
- `--days` and `--hours` are repeated flags: the command above sets `["mon", "fri"]` and `[7, 18]`. `--days '["mon","fri"]'` does the same. In `list`, a repeated flag ends with `...`.
- `aircon status --help` prints the command list of the shared prefix `aircon status`. `aircon status` alone prints it to standard error and exits with code 2.
- Ctrl+C cancels a call or a subscription such as `follow`, with exit code 130.

### Human or JSON output

Each command line in this example sets its default form to `auto`: text for a person in a terminal, JSON in a pipe, in CI or under a coding agent. In a terminal, `aircon status get` prints:

```
off · cool · fan auto · target 22°C · room 25°C
```

`--output human`, `--output json`, `-o human` and `--json` choose the form anywhere in the arguments. In a pipe, the JSON of a result, a failure and `list` is one line: `node core-ts/cli.ts status | cat` prints `{"power":false,"mode":"cool","fan":"auto","targetCelsius":22,"roomCelsius":25}`. In a terminal, `--json` prints the same JSON with an indent of 2. Each core formats the status, the `Offline` failure and the payload of `aircon.status.changed`. See [Human output](../../packages/core-ts/README.md#human-output) for how a core sets this up.

### Aliases

The `cli` target defines eight [aliases](../../spec/bindings/cli.md#aliases) in `options.cli`:

| Alias | Runs |
| --- | --- |
| `status` | `aircon.status.get`. It is the default alias, so the program with no arguments runs it too. |
| `--on`, `--off` | `aircon.power.set` with the fixed input `{ "on": true }` or `{ "on": false }`. |
| `follow` | `watch aircon.status.changed`. |
| `fan` | `aircon.fan.set` with the flag `--speed`. |
| `fan auto`, `fan high` | `aircon.fan.set` with a fixed speed. `fan medium` is an unknown command. |
| `aircon power` | `aircon.power.set` with the flag `--on`. It is the default of the shared prefix `aircon power`; `aircon power set` still works. |

```sh
node core-ts/cli.ts --on
node core-ts/cli.ts                  # the default alias, status
node core-ts/cli.ts follow
node core-effect/cli.ts fan high
node core-ts/cli.ts fan --speed low
node core-ts/cli.ts aircon power --on
cargo run --manifest-path core-rust/Cargo.toml -- cli --off
```

### Control a unit in another process

Each core can serve the [HTTP binding](../../spec/bindings/cli.md#server) of the `cli` target and prints its URL. With `AIRCON_URL` set, the command line sends every call and subscription to that server. Start each server in its own terminal:

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

The MCP servers, WebMCP and the APIs fail with `unknown-capability`. The remote command-line server serves the `cli` target, so it has the capability and fails with `WriteFailed`.

## MCP server through stdio

Each application has an [MCP server through stdio](../../spec/bindings/mcp.md#stdio) for the `mcp` target. Give your MCP client one of these commands, with the repository root as its working directory:

```sh
node examples/aircon/core-ts/mcp-stdio.ts
node examples/aircon/core-effect/mcp-stdio.ts
examples/aircon/core-rust/target/debug/aircon mcp-stdio
```

The process is one session with one simulated unit. It exits when standard input ends.

Look at the tool annotations. The setters, such as `aircon.power.set`, have the [hints](../../spec/catalog.md#capabilities) `destructive` and `idempotent`, and `aircon.status.get` is `readOnly`. The servers send them as `destructiveHint`, `idempotentHint` and `readOnlyHint`.

## WebMCP

Each TypeScript core has a web page for the `app` target, with the [WebMCP binding](../../spec/bindings/webmcp.md). It shows the unit's status, has controls for power, mode, temperature, fan speed and firmware update, and a check box that takes the unit offline.

| Page | Session | WebMCP |
| --- | --- | --- |
| [`core-ts/page.ts`](core-ts/page.ts) | `createSession(aircon, { target: "app", … })` | `installWebMcp(session)` |
| [`core-effect/page.ts`](core-effect/page.ts) | `Session.make(aircon, { target: "app" })`, in one Effect program | `WebMcp.install(session)` |

Both pages use [`web/page.ts`](web/page.ts) and [`web/controls.ts`](web/controls.ts). Serve one:

```sh
node core-ts/serve-page.ts
node core-effect/serve-page.ts
```

The script bundles the page with esbuild, serves it on `127.0.0.1` on a free port, and prints the URL. Pass an address such as `127.0.0.1:8080` to choose the port. Open it in a browser with WebMCP. Without WebMCP, the controls still work and the status reads `no host`.

What to look at:

- Each tool is a capability: `aircon.mode.set` has the bundled type `Mode` in its `$defs`.
- A temperature of 40 rejects with an `Error` whose `kind` is `invalid-input`. `Offline` comes back as a result.
- `aircon.firmware.update` is available only while the unit is online. The page removes the tool when the unit goes offline and registers it again when it comes back.
- The controls and the tools share one session, so a person and an agent see each other's changes.
- The page shows the binding status. It is the installation's `status` in core-ts and its `status` ref in core-effect.

The Rust core has no WebMCP, because it runs as a process, not in a page. Its catalog still has the WebMCP binding on `app`, so the catalog is the same in every language. Rust code uses the `app` target through the [Rust binding](../../spec/bindings/rust.md): the tests in [`core-rust/src/main.rs`](core-rust/src/main.rs) open `Session::open(&app, "app", unit)`, then call `invoke`, `subscribe` and `state`.

[`test/webmcp-page.test.ts`](test/webmcp-page.test.ts) opens each page in Chromium through Playwright with a test WebMCP host.

## APIs

The HTTP and MCP bindings give one route or tool per capability. For an API with your own design, write it as application code on a session, with any library, and serve a binding beside it.

| File | Library | API | Failures |
| --- | --- | --- | --- |
| [`apis/graphql.ts`](apis/graphql.ts) | [Pothos](https://pothos-graphql.dev), [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server), [graphql-ws](https://the-guild.dev/graphql/ws) | `query { status }`, mutations that return the new status, and `subscription { statusChanged }` through server-sent events and WebSockets ([`ws`](https://github.com/websockets/ws)). Schema: [`apis/schema.graphql`](apis/schema.graphql). | A union of `Status` and the failures, for example `Status \| Offline \| PoweredOff` |
| [`apis/capnweb.ts`](apis/capnweb.ts) | [Cap'n Web](https://github.com/cloudflare/capnweb) | A class with typed methods, batched over HTTP or called over WebSockets. `followStatus(listener)` calls the client's function with each new status until the client disposes the result. | `{ ok: false, error }` |
| [`apis/elysia.ts`](apis/elysia.ts) | [Elysia](https://elysiajs.com) on `@elysiajs/node` | `GET /status`, `PATCH /status` (several settings at once), `GET /status/changes` (server-sent events) and the WebSocket `/status/follow`. The HTTP binding is mounted with `.mount("/api", …)`. | Status 409 with the failure |
| [`apis/mcp.ts`](apis/mcp.ts) | [Effect](https://effect.website) `effect/ai` | Tools at `/mcp`: `get_status` (`readOnlyHint`) and `set_controls` (`destructiveHint`, `idempotentHint`). `Mcp.withEvents` from `@acid-cat/core-effect` adds the [MCP events extension](../../spec/bindings/mcp.md#events) for `aircon.status.changed`. | A tool error with the failure |

The first three use the `@acid-cat/core-ts` application, share [`apis/shared.ts`](apis/shared.ts), and serve the HTTP binding at `/api`. The MCP API uses the `@acid-cat/core-effect` application and serves the MCP binding at two URLs:

| URL | Handler | For |
| --- | --- | --- |
| `/capabilities/mcp` | `Mcp.toWebHandler(…)` | Clients of revision `2026-07-28`. |
| `/capabilities/mcp-legacy` | `Mcp.withHandshake(Mcp.toWebHandler(…))` | Clients that open with the [`initialize` handshake](../../spec/bindings/mcp.md#earlier-revisions-through-http) of `2025-11-25` or `2025-06-18`. It keeps no session, so it sends no `notifications/tools/list_changed`. |

Each MCP URL serves an MCP [Server Card](../../spec/bindings/mcp.md#server-card) named `dev.acid-cat/aircon`, at `/mcp/server-card`, `/capabilities/mcp/server-card` and `/capabilities/mcp-legacy/server-card`. The card gives the URL of the server, and the revisions that it serves: `2026-07-28`, and also `2025-11-25` and `2025-06-18` at the legacy URL. At `/mcp`, `Mcp.withEvents` asks the server of the application for `server/discover` and takes the version of the card from its answer, so the card always has the version of that server. Without `serverCard`, each server would serve a card with a default name, such as `local/aircon` at `127.0.0.1`. The other applications serve MCP only through stdio, which has no Server Card.

The input property `on` of `aircon.power.set` has `"x-mcp-header": "On"` in the catalog, and each catalog source and core writes it. Through HTTP, a call of `aircon.power.set` must send the header `Mcp-Param-On: true` or `Mcp-Param-On: false`, with the same value as `on`, or it gets 400 and `-32020` ([Headers](../../spec/bindings/mcp.md#headers)). The official MCP client, and `Mcp.withHandshake` for a client of an earlier revision, send it. Through stdio, the tool gives the annotation, and no header exists.

Every API rejects origins it does not allow.

### How the APIs use sessions

- One session per client ([Sessions](../../spec/invocation.md#sessions)): Each request or Cap'n Web batch opens one with `await using session = openSession(options)`. A WebSocket connection is one session, and closing it ends its subscriptions. The unit is a service in the context, so all sessions share it.
- Typed calls: `session.call(powerSet, input)` checks untrusted input against the input schema and returns a typed result. The MCP API checks its tool parameters with Effect Schema first.
- [Outcomes](../../spec/invocation.md#outcomes): Each API maps a value and a failure to its own form. A call failure rejects as a `CallFailureError`, which each API turns into a protocol error.
- Subscriptions: Each API uses `session.eventHandle(statusChanged).subscribe(…)` and stops when its client goes away:
  - GraphQL returns the subscription as the resolver's iterator; GraphQL calls `return()` when the client ends it.
  - Cap'n Web aborts the signal when the client disposes the `Following` object, the connection breaks, or the listener throws.
  - Elysia's `GET /status/changes` uses the request's signal and sends `retry: 1000` first so the response starts at once. `/status/follow` sends `{ "event": "following" }`, then `{ "event": "aircon.status.changed", "data": <status> }` per change. A WebSocket upgrade from a foreign origin gets 403.
  - MCP: `effect/ai` cannot add methods, so `Mcp.withEvents(aircon, unit, application.handler, options)` answers the events requests before the server sees them, and the server declares `extensions: Mcp.eventsExtensions`. A poll lease also ends when `dispose` runs. See [Push](../../spec/bindings/mcp.md#push) and [Poll](../../spec/bindings/mcp.md#poll).

### Run an API

```sh
node apis/main.ts graphql   # or capnweb, elysia, mcp
```

The API listens on `http://127.0.0.1:3000`. GraphQL and Cap'n Web also serve WebSockets on `ws://127.0.0.1:3001/graphql` and `ws://127.0.0.1:3001/rpc`. Elysia serves its WebSocket on the same port, at `ws://127.0.0.1:3000/status/follow`.

Follow the event in one terminal and change the unit in another:

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
  -d '{"jsonrpc":"2.0","id":1,"method":"events/stream","params":{"name":"aircon.status.changed","arguments":{},"heartbeatMs":30000,"_meta":{"io.modelcontextprotocol/protocolVersion":"2026-07-28","io.modelcontextprotocol/clientCapabilities":{}}}}'
```

The MCP stream starts with `notifications/events/active`, which grants the suggested `heartbeatMs: 30000`. With no `heartbeatMs`, the grant is 15000. The server sends `notifications/events/heartbeat` each time the stream is idle for that interval ([Push](../../spec/bindings/mcp.md#push)).

A Cap'n Web client:

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

The tests run the Python, Go and Rust catalog programs, so they need `python`, `go` and `cargo`; proto installs them from [`.prototools`](../../.prototools). The task `example-aircon:test-rust` builds the Rust program first. The page tests need Chromium, which the task `cli:browser` installs.
