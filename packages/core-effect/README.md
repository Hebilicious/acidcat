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
- `availability` is optional. It is a `Stream` of availability values, or an Effect that gives a `Capability.Current`: a value that the session reads when a call comes in. With a `Stream`, a value reaches the session when its fiber runs, so a call in the same turn as a change is decided on the value before the change. When the availability changes in code that does not wait, use a `Current`, so that each call is decided on the value at that time. `Capability.fromSubscriptionRef(ref)` and `Capability.fromObservable(source)` make one. `Capability.allAvailable(...sources)` is available only when each source is, for example the admission of the session and the guard of an owner:

  ```ts
  availability: Owner.useSync((owner) => Capability.fromObservable(owner.availability)),
  ```
- `state` is an optional `{ schema, changes }`: the schema of the [state](../../spec/invocation.md#state), and a `Stream` of its values. `session.state(id)` follows it.
- Give a shared type an `identifier` annotation. It becomes a named type in `$defs`.

### Services that start on the first call

A `Group` holds services that a group of capabilities shares, and that start on the first call to one of them. For example, the runtime of one domain of an application, which a dynamic `import()` loads. In this example, `./planner-runtime.ts` exports `plannerLayer`, a `Layer` of the `Planner` service:

```ts
import { Capability, Group } from "@acid-cat/core-effect";
import { AVAILABLE, unavailable } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Context, Effect, Layer, Schema } from "effect";

// The owner of the plans: it makes a plan, and tells if it can make one now.
class Planner extends Context.Service<
  Planner,
  {
    readonly availability: Capability.Observable<Availability>;
    readonly generate: (stops: number) => Effect.Effect<string>;
  }
>()("app/Planner") {}

// The group of the planner, a service of the application.
class Planning extends Context.Service<Planning, Group.Group<Planner>>()("app/Planning") {}

const planningLayer = Layer.effect(
  Planning,
  Group.make(Effect.promise(() => import("./planner-runtime.ts")).pipe(Effect.map((module) => module.plannerLayer))),
);

const generate = Capability.make({
  id: "plan.generate",
  description: "Make a plan with some stops.",
  audience: ["app"],
  input: Schema.Struct({ stops: Schema.Int }),
  output: Schema.String,
  availability: Planning.useSync((group) =>
    group.current((services) => Capability.fromObservable(Context.get(services, Planner).availability), {
      dormant: AVAILABLE,
      closed: unavailable("The planner is closed."),
    }),
  ),
  run: ({ stops }) => Planning.use((group) => group.provide(Planner.use((planner) => planner.generate(stops)))),
});
```

- `group.provide(effect)` starts the services if they are dormant, waits for them, and runs the effect with them. All calls share one start. The effect runs in the lifetime of the group: when the group closes, it is interrupted before the services are released, and the call is cancelled.
- When the last call that waits for the start is cancelled, the start is interrupted. The group is `stopping` until the start has released what it built, and a new call waits until then, so two starts never run at the same time. Then the group is dormant again.
- When the start fails, each waiting call dies with `Group.StartFailed`, so a session gives the call failure `internal`. The next call starts the services again.
- `group.current(select, { dormant, closed })` gives a `Capability.Current`, for an availability or a state, that comes from the services once they run. Reading it does not start them.
- The services live in the scope of the group, here the scope of the layer, and are released when it closes. A call that waits when the group closes is cancelled.

For code that does not use Effect, for example a user interface:

- `group.observe(select, { dormant, closed })` gives an observable of a value of the services. Listeners hear each change at once, and subscribing does not start the services. With no `dormant`, reading it before the services run is an error.
- `group.peek(select)` reads the services if they run now, or gives `undefined`. It never starts them.
- `group.startPromise({ signal })` starts the services and waits until they run. The signal stops the wait, and stops the start too when no other call waits for it.

```ts
// `planning` is the group, which code without Effect gets from the services of the application, for example with
// `ManagedRuntime.runSync(Planning)`.
async function showPlanner(planning: Group.Group<Planner>, signal: AbortSignal) {
  await planning.startPromise({ signal });
  const availability = planning.observe((services) => Context.get(services, Planner).availability);
  availability.subscribe((value) => console.info(value.available ? "The planner can make a plan." : value.reason));
}
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

A session opens from the declarations of the capabilities. It writes no JSON Schema when it opens. `session.capabilities` gives the capabilities of the view by id. A binding writes the schemas of a capability only when it needs them, with `App.inputJsonSchema(capability)` and `App.outputJsonSchema(capability)`, and the application keeps them for all later sessions. `session.view` writes the whole view the first time that it is read. A handle follows the availability of its own capability with `session.availabilityChanges(id)`, so a change reaches only that handle. When the availability changes, the listeners of the handle hear the value that `getSnapshot` gives at that moment, never the same value two times in a row. A listener may skip values that changed again before it was told. It follows it only while a listener listens. A session reads a `Capability.Current` when a call comes in, and follows it only while a reader follows `availabilityChanges(id)` or `changes`, so a session and its handles follow no availability when nothing listens. A `Stream` has no way to read its value now, so the session follows each one from the start, to know its value when a call comes in. Use a `Current` to follow nothing until something listens.

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

A handle can also have a snapshot that the application gives: a typed value of the provider, for example a large value that a user interface reads as it is. The TypeScript binding allows this for code in the same process when the catalog has no state (spec/bindings/typescript.md#handles). The `state` of a capability is a part of the catalog, so its handle gives it in its JSON form. Put the capability in a `Handles.leaf` with its snapshot. The handle gives each value as a copy, with the type of the snapshot. `Handles.treeWith` reads snapshots that the services give, and `Handles.capabilities(tree)` gives the capabilities of the tree for `App.make`:

```ts
import { App, Capability, Handles, Session } from "@acid-cat/core-effect";
import { Context, Effect, Schema } from "effect";

interface Workbench {
  readonly items: readonly string[];
}

// The owner of the workbench: its value, as code without Effect reads it.
class Owner extends Context.Service<Owner, { readonly snapshot: Capability.Observable<Workbench> }>()("app/Owner") {}

const inspect = Capability.make({
  id: "workbench.inspect",
  description: "Count the items of the workbench.",
  audience: ["app"],
  output: Schema.Finite,
  run: () => Owner.use((owner) => Effect.succeed(owner.snapshot.getSnapshot().items.length)),
});

const tree = { workbench: { inspect: Handles.leaf(inspect, { snapshot: Owner.useSync((owner) => owner.snapshot) }) } };
const app = App.make({ targets: { app: { bindings: ["typescript"] } }, capabilities: Handles.capabilities(tree) });

const program = Effect.gen(function* () {
  const session = yield* Session.make(app, { target: "app" });
  const handles = yield* Handles.make(app, session);
  const typed = yield* Handles.treeWith(handles, tree);
  return typed.workbench.inspect.snapshot; // Observable<Workbench>, a copy of each value
});
```

A snapshot is data that `structuredClone` copies: a type with a function in it is a type error, and the copy of a class instance is a plain object. A helper that is generic over the snapshot puts `Handles.OnlyData<State>` on its own parameter, as `options: { snapshot: Observable<State> } & Handles.OnlyData<State>`, so that it calls `Handles.leaf` with no cast, and its callers get the check. `Handles.tree` takes leaves with an observable; a leaf with an Effect goes to `treeWith`. A capability with `state`, or outside the view of the session, cannot be a leaf.

`WebMcp.install(session, { host })` gives an `Installation`. For code that does not use Effect, `installation.statusObservable` is its status (phase and message), with the shape of the observables of the handles: listeners hear each change at once. `installation.retryPromise()` tries a failed update again.

`layer` gives the services that the capabilities need. A web handler is `(request: Request) => Promise<Response>`. It works in Node, Bun, Deno and Cloudflare Workers.

### Services for each request

By default, a web handler builds the services from `layer` once, and all requests use them. With the option `services: "per-request"`, the handler builds them for each request that passes the screening, and releases them after the response. Use it when a request must not use objects that an earlier request made, for example on Cloudflare Workers, or when a stateful service must not be shared between callers:

```ts
const handler = Mcp.toWebHandler(app, makeLayer(env), { ...options, services: "per-request" });
```

Both handlers screen a request, and read its body, before they build services or open a session, so a request that they reject builds nothing. The signal of the request cancels its call. A request that is aborted before its response rejects with the reason of its signal, as an aborted `fetch` does.

`Mcp.handle(app, request, options, layer)` and `Http.handle(app, request, options, layer)` screen one request and answer it, with services that they build from `layer` for this request only after the screening. With no `layer`, a host that builds the services itself provides them to this Effect.

### Commands and flags of the application

The CLI binding allows an application to add its own commands and flags. `Cli.command(app, options)` gives the root command. Its options take:

- `commands`: the commands of the application, beside the commands of the capabilities, `call` and `list`. Make each one with `Cli.declare(name, config, handler, { description, examples, subcommands })`, which takes the flags and arguments in the form that `Command.make` takes. `effect/cli` gives no way to read the flags of a command that it made, so the binding makes the command from these parts, and checks them;
- `globalFlags`: the flags of the application, for all commands;
- `services`: the layer of the services of the capabilities. Only the commands of the capabilities, `call` and `list` get it. It can depend on the global flags;
- `description`: the description of the command line in the help of the root command. The default is the description of the application, then its title. `Cli.run` and `NodeCli.main` take it too.

`Cli.command` throws an error when two commands have the same path, at any level, or when two flags in the scope of one command have the same name or alias, so the program stops when it starts. The scope of a command is its own flags and the global flags, of the application and of `effect/cli`. `Cli.print(outcome)` writes an outcome and sets its exit code, so a command of the application gives its outcomes as the commands of the capabilities do. Run the command with `Cli.runCommand`, or with `NodeCli.runCommand` from `@acid-cat/core-effect/node`. Both set the exit codes of the binding. `Cli.exitCodeOf(error)` gives the exit code of one usage error.

```ts
import { Cli } from "@acid-cat/core-effect";
import { NodeCli } from "@acid-cat/core-effect/node";
import { Effect, Layer } from "effect";
import { Argument, Flag, GlobalFlag } from "effect/cli";

const historyFile = GlobalFlag.Setting("history-file")({ flag: Flag.String("history-file") });

const report = Cli.declare("report", { day: Argument.String("day") }, ({ day }) =>
  Effect.map(readReport(day), (value) => ({ ok: true, value })).pipe(Effect.flatMap(Cli.print)),
);

const command = Cli.command(app, {
  name: "aircon",
  version: "0.1.0",
  // The services depend on the flag.
  services: Layer.unwrap(Effect.map(historyFile, (path) => historyLayer(path))),
  globalFlags: [historyFile],
  commands: [report],
});

NodeCli.runCommand(command, { version: "0.1.0" });
```

Standard output carries only the answers (spec/bindings/cli.md#outcomes). The command line writes them through `Cli.Answers`. While the command runs, `NodeCli` writes the answers to standard output, and replaces the global console with one that writes all its output to standard error: logs of Effect, the `Console` of Effect, each method of the global console that other runtimes of the program use, and the help that `effect/cli` shows for a usage error. When the command ends, the program has its own console again. `Cli.run` and `Cli.runCommand` alone do not change the console: they write the answers through `Cli.Answers`, and a program that runs them from its own main program must send its logs and the output of its libraries to standard error itself. The output of `--help`, `--version` and `--completions` goes to standard output.

`@acid-cat/core-effect` works in all runtimes, including browsers. Only `@acid-cat/core-effect/node` needs Node.js.

Each module also has its own entry point, for example `@acid-cat/core-effect/Session`. The package has no side effects, so a bundler keeps only the modules that a program imports, from either entry point. A web page that imports `Session`, `Handles` and `WebMcp` does not contain `Cli` or `Mcp`, or the `effect/cli` and `effect/ai` modules that they use.

## Examples and tests

- [`examples/aircon.ts`](examples/aircon.ts) is the air conditioner of [`examples/aircon.pkl`](../../examples/aircon.pkl), with a simulated unit. Its catalog agrees with the Pkl catalog.
- [`examples/aircon-cli.ts`](examples/aircon-cli.ts) is its command line: `node examples/aircon-cli.ts aircon power set --on`.
- [`examples/apis/src/mcp.ts`](../../examples/apis/src/mcp.ts) builds an MCP server with its own tools on it, beside the MCP binding.
- `moon run core-effect:test` tests sessions and all bindings with a test application, and runs `acid-cat conform` against all bindings.
