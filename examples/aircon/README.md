# Air conditioner

One air conditioner, described once and served to every surface. The unit is simulated in memory. This example shows each part of AcidCat on the same application:

| Directory | Contents |
| --- | --- |
| [`catalog/`](catalog) | The catalog, written in Pkl, TypeScript, Python, Go and Rust. Each language gives the same bytes |
| [`core-ts/`](core-ts) | The application on [`@acid-cat/core-ts`](../../packages/core-ts), with Zod, its command line, and its MCP server through stdio |
| [`core-effect/`](core-effect) | The application on [`@acid-cat/core-effect`](../../packages/core-effect), fully in Effect, its command line, and its MCP server through stdio |
| [`kotlin/`](kotlin) | The application on [`acid-cat-core-kotlin`](../../packages/core-kotlin), its command line, its MCP server through stdio, and an Android app whose app functions come from the catalog |
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

## Kotlin and Android

[`kotlin/`](kotlin) is the same application in Kotlin, on the JVM and on Android. Its test compares its catalog with `aircon.acidcat.json`, as the tests of the TypeScript applications do. The catalog is the contract: each implementation follows it in its own language, and no implementation uses the code of another.

| Part | Target | Surface |
| --- | --- | --- |
| [`aircon/Aircon.kt`](kotlin/aircon/src/main/kotlin/dev/acidcat/example/aircon/Aircon.kt) | | The capabilities, with Kotlin types |
| [`aircon/Cli.kt`](kotlin/aircon/src/main/kotlin/dev/acidcat/example/aircon/Cli.kt) | `cli` | The command line |
| [`aircon/Mcp.kt`](kotlin/aircon/src/main/kotlin/dev/acidcat/example/aircon/Mcp.kt) | `mcp` | The MCP server through stdio |
| [`android/MainActivity.kt`](kotlin/android/src/main/kotlin/dev/acidcat/example/aircon/android/MainActivity.kt) | `app` | The screen of the Android app, through the [Kotlin binding](../../spec/bindings/kotlin.md) |
| [`android/build.gradle.kts`](kotlin/android/build.gradle.kts) | `phone` | The [app functions](../../spec/bindings/appfunctions.md) of the Android app, for the agents on the phone |

The Gradle plugin `dev.acidcat.appfunctions` reads the view of the `phone` target from `aircon.acidcat.json` at build time, and generates the app functions. The screen and the app functions use one simulated unit. Thus when an agent turns the unit on, the screen shows it at once, because the screen follows the state of `aircon.status.get`. `aircon.firmware.update` is only in the `app` target, so the screen can call it, and the agents cannot.

```sh
cd examples/aircon/kotlin
gradle :aircon-kotlin:run --args="aircon schedule set --days mon --days fri"
gradle --quiet :aircon-kotlin:mcp            # an MCP server through stdio
gradle :aircon-android:installDebug           # Android 16 or later
adb shell cmd app_function execute-app-function --package dev.acidcat.example.aircon \
  --function 'dev.acidcat.example.aircon.android.functions.AirconAppFunctionServiceBase#aircon_power_set' --parameters '{"on":true}'
```

## APIs

The HTTP and MCP bindings give generic access to the capabilities: one route or one tool for each id. An API whose design you control is application code. Build it on a session, with the library that you prefer, and serve a binding beside it.

| File | Library | API | Failures |
| --- | --- | --- | --- |
| [`apis/graphql.ts`](apis/graphql.ts) | [Pothos](https://pothos-graphql.dev) and [GraphQL Yoga](https://the-guild.dev/graphql/yoga-server) | `query { status }`, and mutations that return the new status. The schema is in [`apis/schema.graphql`](apis/schema.graphql) | Data: each field returns a union of `Status` and the failures of its capability, for example `Status \| Offline \| PoweredOff` |
| [`apis/capnweb.ts`](apis/capnweb.ts) | [Cap'n Web](https://github.com/cloudflare/capnweb) | A class with typed methods. A client sends many calls in one request | A result value: `{ ok: false, error }` |
| [`apis/elysia.ts`](apis/elysia.ts) | [Elysia](https://elysiajs.com) | `GET /status`, and `PATCH /status` that changes many settings. The HTTP binding is mounted with `.mount("/api", …)` | Status 409 with the failure |
| [`apis/mcp.ts`](apis/mcp.ts) | [Effect](https://effect.website) `effect/ai` | MCP tools `get_status` and `set_controls`, which changes many settings in one call | A tool error with the failure |

The first three APIs use the application on `@acid-cat/core-ts`, and serve the HTTP binding at `/api`. [`apis/shared.ts`](apis/shared.ts) has what they share. The MCP server uses the application on `@acid-cat/core-effect`, and serves the MCP binding at `/capabilities/mcp`. All APIs reject origins that they do not allow.

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
