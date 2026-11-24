---
title: Serve with the Effect core
description: Write capabilities as Effect programs with @acid-cat/core-effect, and serve them through the TypeScript, MCP, HTTP, CLI and WebMCP surfaces.
sidebar:
  order: 23
  label: Effect core
---

`@acid-cat/core-effect` is a core for [Effect](https://effect.website) users. A capability is an Effect program with Effect Schema types, an event is a `Stream`, a session is a scope, services are layers, and a cancellation interrupts a fiber. The package writes the catalog from your declarations. Without Effect, use the [TypeScript core](/docs/guides/serve-with-core-ts/).

<PackageInstall packages="@acid-cat/core-effect effect" />

`NodeCli` and `NodeMcp`, from `@acid-cat/core-effect/node`, also need `@effect/platform-node`:

<PackageInstall packages="@effect/platform-node" />

`effect` (version 4) and `@effect/platform-node` are peer dependencies, so the application and the core share one Effect.

## A first command line

```ts title="greeter.ts"
import { App, Capability } from "@acid-cat/core-effect";
import { NodeCli } from "@acid-cat/core-effect/node";
import { Effect, Layer, Schema } from "effect";

const greet = Capability.make({
  id: "greeting.say",
  description: "Say hello to a person.",
  audience: ["cli"],
  input: Schema.Struct({ name: Schema.String }),
  output: Schema.Struct({ message: Schema.String }),
  run: ({ name }) => Effect.succeed({ message: `Hello, ${name}.` }),
});

export const greeter = App.make({
  title: "Greeter",
  targets: { cli: { surfaces: ["cli"] } },
  capabilities: [greet],
});

NodeCli.main(greeter, Layer.empty, { name: "greeter", version: "0.1.0" });
```

```sh
$ node greeter.ts greeting say --name Ada
{
  "message": "Hello, Ada."
}
```

## Write capabilities

```ts title="aircon.ts"
import { App, Capability } from "@acid-cat/core-effect";
import { Effect, Schema } from "effect";

const Offline = Schema.TaggedStruct("Offline", {});

export const aircon = App.make({
  title: "Living-room air conditioner",
  targets: { cli: { surfaces: ["cli"] }, mcp: { surfaces: ["mcp"] } },
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

- `input` is a `Schema.Struct`, or a `Schema.Union` of structs.
- `failures` are `Schema.TaggedStruct`s. The tag is the failure tag of the catalog.
- For numbers, use `Schema.Finite` or `Schema.Int`. `Schema.Number` accepts `Infinity` and `NaN`, which JSON cannot hold.
- An `identifier` annotation on a shared type makes it a named type in `$defs`.
- `availability` and `state` take a `SubscriptionRef`. Make each ref in a layer, so all sessions share it.

## Write events

This excerpt of `aircon.ts` declares an event:

```ts title="aircon.ts"
import { App, Event } from "@acid-cat/core-effect";
import { Schema, Stream } from "effect";

const Status = Schema.Struct({ power: Schema.Boolean, celsius: Schema.Int }).annotate({ identifier: "Status" });

export const statusChanged = Event.make({
  id: "aircon.status.changed",
  description: "The status of the unit changed.",
  audience: ["app", "mcp"],
  input: Schema.Struct({}),
  payload: Status,
  subscribe: () => Unit.statusChanges.pipe(Stream.map((status) => ({ data: status }))),
});
```

The stream has no error channel. Put a problem of the source in the payload, for example as a union with a `_tag`. Release resources with `Stream.ensuring` or a scoped resource.

## Write the catalog

```ts title="catalog.ts"
import { writeFile } from "node:fs/promises";
import { App } from "@acid-cat/core-effect";

await writeFile("acidcat.catalog.json", App.render(aircon));
```

## Serve each surface

| Module | Surface | Entry point |
| --- | --- | --- |
| `Session` | Invocation and events in Effect | `Session.make(app, { target })` |
| `Handles` | TypeScript, for code without Effect | `Handles.open(app, layer, { target, webmcp })` |
| `Mcp` | MCP through HTTP | `Mcp.toWebHandler(app, layer, options)` |
| `NodeMcp` | MCP through stdio | `NodeMcp.main(app, layer, options)` |
| `Http` | HTTP | `Http.toWebHandler(app, layer, options)` |
| `NodeCli` | CLI | `NodeCli.main(app, layer, options)` |
| `WebMcp` | WebMCP | `WebMcp.install(session)` |
| `NodeServer` | Serves the MCP and HTTP handlers on Node.js | `NodeServer.serve(handler, options)`, `NodeServer.layer(handler, options)` |

`layer` gives the services of the capabilities. A web handler runs on Node.js, Bun, Deno and Cloudflare Workers. An aborted request signal cancels the call of that request.

### On Node.js

```ts title="serve.ts"
import * as NodeServer from "@acid-cat/core-effect/NodeServer";
import { Effect, Layer } from "effect";

const mcp = Mcp.toWebHandler(aircon, unitLayer, mcpOptions);
const http = Http.toWebHandler(aircon, unitLayer, httpOptions);

Layer.launch(NodeServer.layer({ "/mcp": mcp, "/": http }, { port: 3000 })).pipe(Effect.runFork);
```

The options of `Mcp.toWebHandler` include `name`, `version` and `allowedOrigins`. The options of `Http.toWebHandler` include `allowedOrigins`. `hostname` is `127.0.0.1` by default. Use `0.0.0.0` or `::` to accept connections from the network.

::: caution
`NodeServer` is plain HTTP/1.1. For network clients, end TLS in front of it, for example in a load balancer or a Kubernetes ingress.
:::

### MCP through stdio

```ts title="mcp.ts"
#!/usr/bin/env node
import { NodeMcp } from "@acid-cat/core-effect/node";

NodeMcp.main(aircon, unitLayer, { name: "aircon", version: "1.0.0" });
```

Effect logs go to standard error. Do not write to standard output from a capability.

### Typed calls

```ts
import { Session } from "@acid-cat/core-effect";

const program = Effect.scoped(
  Effect.gen(function* () {
    const session = yield* Session.make(aircon, { target: "mcp" });
    return yield* session.call(powerSet, { on: true });
  }),
);
```

For code without Effect, such as a user interface, `Handles.open` gives a session with promises:

```ts
import { Handles, WebMcp } from "@acid-cat/core-effect";

await using session = await Handles.open(aircon, unitLayer, { target: "app", webmcp: WebMcp.findHost() });
const power = session.handle(powerSet);
await power.execute({ on: true });
```

With the `webmcp` option, the session registers its tools on that host until it closes.

### Services for each request

By default, a web handler builds `layer` one time, and all requests share it. With `services: "per-request"`, it builds the layer for each request, and releases it after the response. Use it when requests must not share objects, as on Cloudflare Workers:

```ts
const handler = Mcp.toWebHandler(app, makeLayer(env), { ...options, services: "per-request" });
```

## The command line

`NodeCli.main` serves the catalog of the `cli` target. `App.alias(capabilityOrEvent, fixedInput?)` makes an alias, and `App.aliasDefault` makes the default alias:

```ts
targets: {
  cli: {
    surfaces: ["cli"],
    cli: {
      aliases: {
        status: App.aliasDefault(statusGet),
        "--on": App.alias(powerSet, { on: true }),
        "--off": App.alias(powerSet, { on: false }),
        "aircon power": App.alias(powerSet),
        follow: App.alias(statusChanged),
        fan: App.alias(fanSet),
        "fan high": App.alias(fanSet, { speed: "high" }),
      },
    },
  },
},
```

```sh
node cli.ts --on      # the same call as: node cli.ts aircon power set --on
node cli.ts follow    # the same subscription as: node cli.ts watch aircon.status.changed
node cli.ts           # the default alias: node cli.ts status
```

With the `remote` option and `Http.client(url)`, the command line calls the HTTP surface of a server.

## Read more

- The full [`@acid-cat/core-effect` README](https://github.com/Hebilicious/acidcat/blob/main/packages/core-effect/README.md): availability and state, poll and webhook delivery, events beside your own MCP server, output for a person, and application flags and commands.
- [The air conditioner on the Effect core](/docs/examples/core-effect/), in a code explorer.
