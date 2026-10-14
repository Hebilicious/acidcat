# @acid-cat/core-ts

Serve AcidCat capabilities in plain TypeScript. npm package: `@acid-cat/core-ts`.

This package has no Effect dependency. A capability returns a promise. Inputs are validated with any library that implements [Standard Schema](https://standardschema.dev), for example Zod, Valibot or ArkType. The application writes its own catalog.

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
      run: async ({ on }, { context, signal }) => ((await context.unit.setPower(on, signal)) ? ok(null) : fail("Offline")),
    }),
  ],
});
```

- `run` gets the input, an `AbortSignal` and the context. It returns `ok(value)` or `fail(tag, data)`. If it throws, the call fails as `internal`.
- A failure schema describes the whole failure object, with its `_tag`.
- `availability` is an optional function that returns an observable availability.
- `state` is an optional `{ schema, source }`: the schema of the [state](../../spec/invocation.md#state), and a function that returns an observable. The handle gives it as `snapshot`.
- `capabilitiesFor<Context>()` sets the context type one time. The other types come from the schemas.

## Write the catalog

```ts
import { renderCatalog } from "@acid-cat/core-ts";

const toJsonSchema = (schema) => z.toJSONSchema(schema, { target: "draft-2020-12" });
await writeFile("acidcat.catalog.json", renderCatalog(aircon, { toJsonSchema })); // canonical form
```

Standard Schema does not convert to JSON Schema. Give the converter of your schema library as `toJsonSchema`.

## Serve the capabilities

| Function | Binding | Result |
| --- | --- | --- |
| `createSession(app, options)` | [TypeScript](../../spec/bindings/typescript.md) | A session with a handle for each capability in the view |
| `mcpHandler(app, options)` | [MCP](../../spec/bindings/mcp.md) | `(request: Request) => Promise<Response>` |
| `httpHandler(app, options)` | [HTTP](../../spec/bindings/http.md) | `(request: Request) => Promise<Response>` |
| `cliMain(app, options)`, `runCli(…)` | [CLI](../../spec/bindings/cli.md) | The command line of the process, or an exit code |
| `installWebMcp(session)` | [WebMCP](../../spec/bindings/webmcp.md) | Tools in the page, with a status |

## Examples and tests

- [`examples/aircon.ts`](examples/aircon.ts) is the air conditioner of [`examples/aircon.pkl`](../../examples/aircon.pkl), with a simulated unit. Its catalog agrees with the Pkl catalog.
- [`examples/aircon-cli.ts`](examples/aircon-cli.ts) is its command line: `node examples/aircon-cli.ts aircon power set --on`.
- [`examples/apis`](../../examples/apis/README.md) builds GraphQL, Cap'n Web and Elysia APIs on it, each beside the HTTP binding.
- `moon run core-ts:test` tests sessions, handles and all bindings with a test application, and runs `acid-cat conform` against all bindings.
