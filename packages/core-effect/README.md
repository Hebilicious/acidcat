# @acid-cat/core-effect

Serve AcidCat capabilities with [Effect](https://effect.website). npm package: `@acid-cat/core-effect`.

All of this package is Effect: a capability is an Effect program with Effect Schema types, a session is a scope, and the services of the application are layers. The application writes its own catalog.

```sh
pnpm add @acid-cat/core-effect effect
pnpm add @effect/platform-node  # only for @acid-cat/core-effect/node
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

- `input` is a `Schema.Struct`. With no `input`, the input is an empty object. Use `Schema.Finite` or `Schema.Int` for numbers: `Schema.Number` also accepts `Infinity` and `NaN`, which JSON cannot hold.
- Each failure is a `Schema.TaggedStruct`. Its tag is the tag in the catalog.
- `availability` is an optional `Stream` of availability values.
- `state` is an optional `{ schema, changes }`: the schema of the [state](../../spec/invocation.md#state), and a `Stream` of its values. `session.state(id)` follows it.
- Give a shared type an `identifier` annotation. It becomes a named type in `$defs`.

## Write the catalog

```ts
import { App } from "@acid-cat/core-effect";

await writeFile("acidcat.catalog.json", App.render(aircon)); // canonical form
```

## Serve the capabilities

| Module | Binding | Entry point |
| --- | --- | --- |
| `Session` | [Invocation](../../spec/invocation.md) | `Session.make(app, { target })`: `invoke` for untrusted input, `execute` for typed calls |
| `Handles` | [TypeScript](../../spec/bindings/typescript.md) | `Handles.make(app, session)`: handles with promises and observables, for code that does not use Effect, such as a user interface. `Handles.open(app, layer, { target })` opens a session from code that does not use Effect |
| `Mcp` | [MCP](../../spec/bindings/mcp.md) | `Mcp.toWebHandler(app, layer, options)`, on `effect/ai/McpServer` |
| `Http` | [HTTP](../../spec/bindings/http.md) | `Http.toWebHandler(app, layer, options)` |
| `Cli` | [CLI](../../spec/bindings/cli.md) | `Cli.run(app, options)`, on `effect/cli`. `NodeCli.main(app, layer, options)` from `@acid-cat/core-effect/node` runs it as the main program of a Node.js process |
| `WebMcp` | [WebMCP](../../spec/bindings/webmcp.md) | `WebMcp.install(session)` |

`layer` gives the services that the capabilities need. A web handler is `(request: Request) => Promise<Response>`. It works in Node, Bun, Deno and Cloudflare Workers.

`@acid-cat/core-effect` works in all runtimes, including browsers. Only `@acid-cat/core-effect/node` needs Node.js.

Each module also has its own entry point, for example `@acid-cat/core-effect/Session`. The package has no side effects, so a bundler keeps only the modules that a program imports, from either entry point. A web page that imports `Session`, `Handles` and `WebMcp` does not contain `Cli` or `Mcp`, or the `effect/cli` and `effect/ai` modules that they use.

## Examples and tests

- [`examples/aircon.ts`](examples/aircon.ts) is the air conditioner of [`examples/aircon.pkl`](../../examples/aircon.pkl), with a simulated unit. Its catalog agrees with the Pkl catalog.
- [`examples/aircon-cli.ts`](examples/aircon-cli.ts) is its command line: `node examples/aircon-cli.ts aircon power set --on`.
- [`examples/apis/src/mcp.ts`](../../examples/apis/src/mcp.ts) builds an MCP server with its own tools on it, beside the MCP binding.
- `moon run core-effect:test` tests sessions and all bindings with a test application, and runs `acid-cat conform` against all bindings.
