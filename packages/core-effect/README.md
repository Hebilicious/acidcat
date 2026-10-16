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

- `input` is a `Schema.Struct`, or a `Schema.Union` of structs. The catalog writes a union with `"type": "object"`, so that it is an object schema. With no `input`, the input is an empty object. Use `Schema.Finite` or `Schema.Int` for numbers: `Schema.Number` also accepts `Infinity` and `NaN`, which JSON cannot hold.
- Each failure is a `Schema.TaggedStruct`. Its tag is the tag in the catalog.
- `availability` is an optional Effect that gives a `SubscriptionRef` of availability values. With no `availability`, the capability is always available.
- `state` is an optional `{ schema, value }`: the schema of the [state](../../spec/invocation.md#state), and an Effect that gives a `SubscriptionRef` of its values. Handles need a state schema that encodes synchronously, because `getSnapshot` is synchronous. `Handles.make` fails with an error that names the capability if the schema does not.
- Give a shared type an `identifier` annotation. It becomes a named type in `$defs`.
- `Capability.make` keeps the literal type of `id`, so that an application can type its ids, for example `typeof powerSet.id`. The capability needs the services that `run`, `availability` and `state` need.

### Availability and state

A session gets the ref of each availability and each state one time, when it opens. It starts no fiber. It reads the availability ref when a call comes in, so a call that comes after `SubscriptionRef.set` is decided on the new value. `session.changes` and `session.state(id)` follow the refs only while they run, and a handle follows its refs only while it has listeners.

Make each ref in a layer, so that all sessions share it. If the source of an availability or a state is a `Stream`, follow the stream one time in that layer:

```ts
import { AVAILABLE } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Context, Effect, Layer, Stream, SubscriptionRef } from "effect";

class Connection extends Context.Service<Connection, SubscriptionRef.SubscriptionRef<Availability>>()("app/Connection") {}

const connectionLayer = Layer.effect(
  Connection,
  Effect.gen(function* () {
    const ref = yield* SubscriptionRef.make<Availability>(AVAILABLE);
    // `connectionChanges` is a Stream<Availability>. The fiber stops when the layer is released.
    yield* connectionChanges.pipe(Stream.runForEach((value) => SubscriptionRef.set(ref, value)), Effect.forkScoped);
    return ref;
  }),
);

export const firmwareUpdate = Capability.make({
  id: "aircon.firmware.update",
  description: "Install the latest firmware.",
  audience: ["app"],
  availability: Connection,
  run: () => Effect.succeed(null),
});
```

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

`layer` gives the services that the capabilities need. A web handler is `(request: Request) => Promise<Response>`. It works in Node, Bun, Deno and Cloudflare Workers. When the signal of a request aborts, the handler cancels the call of the request.

### Typed handles

`Handles.get(handles, capability)` gives the handle of a capability with the types of its schemas: `execute` takes the decoded input, and gives the decoded value or failure. `snapshot` gives the state in its JSON form. For a capability outside the view, the handle is always unavailable, and each call rejects as `unknown-capability`.

```ts
import { Handles } from "@acid-cat/core-effect";

const session = await Handles.open(aircon, unitLayer, { target: "app" });
const power = Handles.get(session.handles, powerSet); // Handles.HandleOf<typeof powerSet>
const result = await power.execute({ on: true }); // Result<null, typeof Offline.Type>
```

### Services for each request

By default, a web handler builds the services from `layer` once, for the first request that passes the screening, and all requests use them. With the option `services: "per-request"`, the handler builds them for each request that passes the screening, and releases them after the response. Use it when a request must not use objects that an earlier request made, for example on Cloudflare Workers, or when a stateful service must not be shared between callers:

```ts
const handler = Mcp.toWebHandler(app, makeLayer(env), { ...options, services: "per-request" });
```

`Mcp.handle(app, request, options)` and `Http.handle(app, request, options)` screen one request and answer it. A host that builds the services itself provides them to this Effect.

### Flags of the application

The CLI binding allows an application to add its own flags. `Cli.command(app, options)` gives the command. Change it with `effect/cli`, then run it with `Cli.runCommand`, or with `NodeCli.runCommand` from `@acid-cat/core-effect/node`. Both set the exit codes of the binding. `Cli.exitCodeOf(error)` gives the exit code of one usage error.

```ts
import { Cli } from "@acid-cat/core-effect";
import { NodeCli } from "@acid-cat/core-effect/node";
import { Effect, Layer } from "effect";
import { Command, Flag, GlobalFlag } from "effect/cli";

const historyFile = GlobalFlag.Setting("history-file")({ flag: Flag.String("history-file") });

// The services depend on the flag.
const services = Layer.unwrap(Effect.map(historyFile, (path) => historyLayer(path)));

const command = Cli.command(app, { name: "aircon", version: "0.1.0" }).pipe(
  Command.provide(services),
  Command.withGlobalFlags([historyFile]),
);

NodeCli.runCommand(command, { version: "0.1.0" });
```

### Commands of the application

The option `commands` adds commands of the application beside the commands of the capabilities, `call` and `list`. Each one is an `effect/cli` command. Its name must not be `call`, `list`, the name of another command of the application, or the first word of the command of a capability. If it is, `Cli.command` throws. The option `description` gives the text at the top of the help. The default is the description of the application, then its title, then the name of the program.

```ts
import { NodeCli } from "@acid-cat/core-effect/node";
import { Console, Effect, SubscriptionRef } from "effect";
import { Command } from "effect/cli";

const report = Command.make("report", {}, () =>
  Effect.gen(function* () {
    const state = yield* SubscriptionRef.get(yield* Unit);
    yield* Console.log(`The room is at ${state.roomCelsius} °C.`);
  }),
).pipe(Command.withDescription("Write the temperature of the room."));

// The layer gives the services of the capabilities and of the commands of the application.
NodeCli.main(aircon, unitLayer, { name: "aircon", version: "0.1.0", description: "Control the air conditioner.", commands: [report] });
```

`@acid-cat/core-effect` works in all runtimes, including browsers. Only `@acid-cat/core-effect/node` needs Node.js.

Each module also has its own entry point, for example `@acid-cat/core-effect/Session`. The package has no side effects, so a bundler keeps only the modules that a program imports, from either entry point. A web page that imports `Session`, `Handles` and `WebMcp` does not contain `Cli` or `Mcp`, or the `effect/cli` and `effect/ai` modules that they use.

## Examples and tests

- [`examples/aircon.ts`](examples/aircon.ts) is the air conditioner of [`examples/aircon.pkl`](../../examples/aircon.pkl), with a simulated unit. Its catalog agrees with the Pkl catalog.
- [`examples/aircon-cli.ts`](examples/aircon-cli.ts) is its command line: `node examples/aircon-cli.ts aircon power set --on`.
- [`examples/apis/src/mcp.ts`](../../examples/apis/src/mcp.ts) builds an MCP server with its own tools on it, beside the MCP binding.
- `moon run core-effect:test` tests sessions and all bindings with a test application, and runs `acid-cat conform` against all bindings.
