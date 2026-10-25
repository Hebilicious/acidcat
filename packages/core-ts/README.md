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

When the signal of a request aborts, `mcpHandler` and `httpHandler` cancel the call of the request.

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

### Context for each request

`mcpHandler` and `httpHandler` take `context` or `createContext`. With `context`, all requests share one context. With `createContext(request)`, the handler makes a new context for each request that passes the screening. Use it when a request must not use objects that an earlier request made, for example on Cloudflare Workers, or when a stateful service must not be shared between callers. When the context has `Symbol.asyncDispose` or `Symbol.dispose`, the handler calls it after the response:

```ts
const handler = httpHandler(aircon, {
  allowedOrigins: [],
  toJsonSchema,
  createContext: () => ({ unit: connectUnit(env), [Symbol.asyncDispose]: () => disconnectUnit() }),
});
```

### Commands of the application

The option `commands` of `cliMain` and `runCli` adds commands of the application beside the commands of the capabilities, `call` and `list`. A command has a `name`, a `description` for the help, and `run(args, io)`. `run` gets the arguments after the name of the command, and `io` with `stdout`, `stderr`, `signal` and the `context`. It returns the exit code. The name must not be `call`, `list`, the name of another command of the application, or the first word of the command of a capability. If it is, `runCli` throws. The option `description` gives the text at the top of the help. The default is the description of the application, then its title, then the name of the program.

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
