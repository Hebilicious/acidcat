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
| [`apis/graphql.ts`](apis/graphql.ts) | [Pothos](https://pothos-graphql.dev) and [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) | `query { status }`, and mutations that return the new status. The schema is in [`apis/schema.graphql`](apis/schema.graphql) | Data: each field returns a union of `Status` and the failures of its capability, for example `Status \| Offline \| PoweredOff` |
| [`apis/capnweb.ts`](apis/capnweb.ts) | [Cap'n Web](https://github.com/cloudflare/capnweb) | A class with typed methods. A client sends many calls in one request | A result value: `{ ok: false, error }` |
| [`apis/elysia.ts`](apis/elysia.ts) | [Elysia](https://elysiajs.com) | `GET /status`, and `PATCH /status` that changes many settings. The HTTP binding is mounted with `.mount("/api", …)` | Status 409 with the failure |
| [`apis/mcp.ts`](apis/mcp.ts) | [Effect](https://effect.website) `effect/ai` | MCP tools `get_status` and `set_controls`, which changes many settings in one call | A tool error with the failure |

The first three APIs use the application on `@acid-cat/core-ts`, and serve the HTTP binding at `/api`. [`apis/shared.ts`](apis/shared.ts) has what they share. The MCP server uses the application on `@acid-cat/core-effect`, and serves the MCP binding at `/capabilities/mcp`. The binding is wrapped in `Mcp.withHandshake`, so MCP clients that open the session with the [`initialize` handshake](../../spec/bindings/mcp.md#earlier-revisions-through-http) of revision `2025-11-25` can use it too. All APIs reject origins that they do not allow.

Each API calls the capabilities through a session, so it gets the same outcomes as all other surfaces:

- **One session for each client.** A session serves one client (see [Sessions](../../spec/invocation.md#sessions)). Each request, or each Cap'n Web batch, opens its own session with `await using session = openSession(options)`. The session closes when the block ends. The unit is a service in the context, so all sessions share it.
- **Typed calls.** An API gets input that is not trusted. `session.call(powerSet, input)` checks it with the input schema of the capability, and gives a result with the types of the capability, with no cast. The MCP server checks the parameters of its tools with Effect Schema, then calls the session of `@acid-cat/core-effect`.
- **Three outcomes.** A value and a failure are results: each API gives them in its own form, as data, as a union member, or as a status code. A call failure rejects as a `CallFailureError`, and each API turns it into an error of its protocol.

## Run

```sh
node apis/main.ts graphql   # or capnweb, elysia, mcp
moon run example-aircon:test
```

`apis/main.ts` serves the API on `http://127.0.0.1:3000`, with `serve` from `@acid-cat/core-ts/node`.

The test runs the Python, Go and Rust programs of `catalog/`, so it needs `python`, `go` and `cargo`. proto installs them from [`.prototools`](../../.prototools).
