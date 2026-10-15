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
- `availability` is optional. It is a `Stream` of availability values, or an Effect that gives a `Capability.Current`: a value that the session reads when a call comes in. With a `Stream`, a value reaches the session when its fiber runs, so a call in the same turn as a change is decided on the value before the change. When the availability changes in code that does not wait, use a `Current`, so that each call is decided on the value at that time. `Capability.fromSubscriptionRef(ref)` and `Capability.fromObservable(source)` make one:

  ```ts
  availability: Owner.useSync((owner) => Capability.fromObservable(owner.availability)),
  ```
- `state` is an optional `{ schema, changes }`: the schema of the [state](../../spec/invocation.md#state), and a `Stream` of its values. `session.state(id)` follows it.
- Give a shared type an `identifier` annotation. It becomes a named type in `$defs`.

### Services that start on the first call

A `Group` holds services that a group of capabilities shares, and that start on the first call to one of them. For example, the runtime of one domain of an application, which a dynamic `import()` loads:

```ts
import { Capability, Group } from "@acid-cat/core-effect";
import { AVAILABLE, unavailable } from "@acid-cat/spec-ts";
import { Context, Effect, Layer } from "effect";

class Bartering extends Context.Service<Bartering, Group.Group<BarteringOwner>>()("app/Bartering") {}

const barteringLayer = Layer.effect(
  Bartering,
  Group.make(Effect.promise(() => import("./bartering-runtime.ts")).pipe(Effect.map((module) => module.ownerLayer))),
);

Capability.make({
  id: "bartering.plan.generate",
  // ...
  availability: Bartering.useSync((group) =>
    group.current((services) => Capability.fromObservable(Context.get(services, BarteringOwner).availability), {
      dormant: AVAILABLE,
      closed: unavailable("The bartering domain is closed."),
    }),
  ),
  run: (input) => Bartering.use((group) => group.provide(BarteringOwner.use((owner) => owner.generate(input)))),
});
```

- `group.provide(effect)` starts the services if they are dormant, waits for them, and runs the effect with them. All calls share one start.
- When the last call that waits for the start is cancelled, the start is interrupted. The group is `stopping` until the start has released what it built, and a new call waits until then, so two starts never run at the same time. Then the group is dormant again.
- When the start fails, each waiting call dies with `Group.StartFailed`, so a session gives the call failure `internal`. The next call starts the services again.
- `group.current(select, { dormant, closed })` gives a `Capability.Current`, for an availability or a state, that comes from the services once they run. Reading it does not start them.
- The services live in the scope of the group, here the scope of the layer, and are released when it closes. A call that waits when the group closes is cancelled.

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

A session opens from the declarations of the capabilities. It writes no JSON Schema when it opens. `session.capabilities` gives the capabilities of the view by id. A binding writes the schemas of a capability only when it needs them, with `App.inputJsonSchema(capability)` and `App.outputJsonSchema(capability)`, and the application keeps them for all later sessions. `session.view` writes the whole view the first time that it is read. A handle follows the availability of its own capability with `session.availabilityChanges(id)`, so a change reaches only that handle. When the availability changes, the listeners of the handle hear the value that `getSnapshot` gives at that moment, never the same value two times in a row. A listener may skip values that changed again before it was told.

`Handles.tree(handles, tree)` gives the handles in a tree that the application chooses, each typed by its capability: `execute` takes the input type and resolves with the value and failure types of its schemas. `Handles.get(handles, capability)` gives one typed handle. A capability outside the view has a handle that is always unavailable.

```ts
import { App, Capability, Handles } from "@acid-cat/core-effect";
import { Effect, Layer, Schema } from "effect";

const Offline = Schema.TaggedStruct("Offline", {});

const powerSet = Capability.make({
  id: "aircon.power.set",
  description: "Turn the unit on or off.",
  audience: ["app"],
  input: Schema.Struct({ on: Schema.Boolean }),
  failures: [Offline],
  run: () => Effect.succeed(null),
});

const app = App.make({ targets: { app: { bindings: ["typescript"] } }, capabilities: [powerSet] });

const session = await Handles.open(app, Layer.empty, { target: "app" });
const aircon = Handles.tree(session.handles, { power: { set: powerSet } });
await aircon.power.set.execute({ on: true }); // Promise<Result<null, { readonly _tag: "Offline" }>>
```

`layer` gives the services that the capabilities need. A web handler is `(request: Request) => Promise<Response>`. It works in Node, Bun, Deno and Cloudflare Workers.

### Services for each request

By default, a web handler builds the services from `layer` once, and all requests use them. With the option `services: "per-request"`, the handler builds them for each request that passes the screening, and releases them after the response. Use it when a request must not use objects that an earlier request made, for example on Cloudflare Workers, or when a stateful service must not be shared between callers:

```ts
const handler = Mcp.toWebHandler(app, makeLayer(env), { ...options, services: "per-request" });
```

Both handlers screen a request, and read its body, before they build services or open a session, so a request that they reject builds nothing. The signal of the request cancels its call. A request that is aborted before its response rejects with the reason of its signal, as an aborted `fetch` does.

`Mcp.handle(app, request, options, layer)` and `Http.handle(app, request, options, layer)` screen one request and answer it, with services that they build from `layer` for this request only after the screening. With no `layer`, a host that builds the services itself provides them to this Effect.

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

`@acid-cat/core-effect` works in all runtimes, including browsers. Only `@acid-cat/core-effect/node` needs Node.js.

Each module also has its own entry point, for example `@acid-cat/core-effect/Session`. The package has no side effects, so a bundler keeps only the modules that a program imports, from either entry point. A web page that imports `Session`, `Handles` and `WebMcp` does not contain `Cli` or `Mcp`, or the `effect/cli` and `effect/ai` modules that they use.

## Examples and tests

- [`examples/aircon.ts`](examples/aircon.ts) is the air conditioner of [`examples/aircon.pkl`](../../examples/aircon.pkl), with a simulated unit. Its catalog agrees with the Pkl catalog.
- [`examples/aircon-cli.ts`](examples/aircon-cli.ts) is its command line: `node examples/aircon-cli.ts aircon power set --on`.
- [`examples/apis/src/mcp.ts`](../../examples/apis/src/mcp.ts) builds an MCP server with its own tools on it, beside the MCP binding.
- `moon run core-effect:test` tests sessions and all bindings with a test application, and runs `acid-cat conform` against all bindings.
