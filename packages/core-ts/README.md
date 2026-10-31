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
| `mcpHandler(app, options)` | [MCP](../../spec/bindings/mcp.md#http) through HTTP | `(request: Request) => Promise<Response>` |
| `mcpHandshake(handler)` | [MCP](../../spec/bindings/mcp.md#earlier-revisions-through-http) through HTTP, for earlier revisions | The handler, which also serves the `initialize` handshake of earlier revisions. From [`@acid-cat/mcp-handshake`](../mcp-handshake) |
| `mcpStdioMain(app, options)`, `runMcpStdio(…)` | [MCP](../../spec/bindings/mcp.md#stdio) through stdio | The MCP server of the process, or a promise that resolves when the input ends |
| `httpHandler(app, options)` | [HTTP](../../spec/bindings/http.md) | `(request: Request) => Promise<Response>` |
| `cliMain(app, options)`, `runCli(…)` | [CLI](../../spec/bindings/cli.md) | The command line of the process, or an exit code |
| `installWebMcp(session)` | [WebMCP](../../spec/bindings/webmcp.md) | Tools in the page, with a status |
| `serve(handler, options)`, from `@acid-cat/core-ts/node` | MCP and HTTP | A Node.js server for the web handlers. See [Serve on Node.js](#serve-on-nodejs) |

When the signal of a request aborts, `mcpHandler` and `httpHandler` cancel the call of the request.

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

`serve` gives a plain HTTP/1.1 server. For more, use a library for web handlers, for example [srvx](https://srvx.h3.dev): HTTPS, HTTP/2, middleware, or the same server code on Bun and Deno. Give it the handler. Make sure that the library aborts the signal of a request when the client closes the connection. If it does not, a closed connection does not cancel the call.

### MCP through stdio

An MCP client, for example a coding agent, can start the server as a local process. `mcpStdioMain` serves the standard input and output of the process. The process is one session, with one `context`. The server serves revision `2026-07-28`, and the `initialize` handshake of revisions `2025-11-25` and `2025-06-18`. When the availability of a capability changes, the server sends `notifications/tools/list_changed`. `notifications/cancelled` cancels a call. When standard input ends, the session closes and the calls in progress are cancelled.

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

`list` gives a usage line for each capability. The usage of a repeated flag ends with `...`, for example `--days <mon|tue|wed|thu|fri|sat|sun>... [--hours <integer>...]`. See the [CLI binding](../../spec/bindings/cli.md#commands) for all the rules.

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
