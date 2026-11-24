---
title: Serve with the TypeScript core
description: Write capabilities and events with @acid-cat/core-ts, and serve them through the TypeScript, MCP, HTTP, CLI and WebMCP surfaces.
sidebar:
  order: 22
  label: TypeScript core
---

`@acid-cat/core-ts` is a core in plain TypeScript, with no Effect dependency. A capability is an async function, and an event is an async iterable. Schemas use any [Standard Schema](https://standardschema.dev) library, such as Zod, Valibot or ArkType. The application writes its own catalog from its code.

<PackageInstall packages="@acid-cat/core-ts" />

The package needs Node.js 24 or later. Start with the [Quick start](/docs/quick-start/) if you have not used it before.

## Write capabilities with a context

A capability often needs a service from outside, such as the connection to the unit. Give its type one time with `capabilitiesFor<Context>()`, and give the same type to `defineApp<Context>`:

```ts title="aircon.ts"
import { capabilitiesFor, defineApp, fail, ok } from "@acid-cat/core-ts";
import { z } from "zod";

const Offline = z.object({ _tag: z.literal("Offline") });
const capability = capabilitiesFor<{ unit: Unit }>();

export const aircon = defineApp<{ unit: Unit }>({
  title: "Living-room air conditioner",
  targets: { cli: { surfaces: ["cli"] }, mcp: { surfaces: ["mcp"] } },
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

- `run(input, { signal, context, target })` gets the decoded input, an `AbortSignal`, the context and the target of the session.
- `run` returns `ok(value)` or `fail(failure)`. If `run` throws, the call fails as `internal`.
- The context comes from the `context` option of `cliMain`, `httpHandler` and the other entry points.
- `availability` and `state` are optional. They give observables that the session reads.

## Write events

`subscribe` returns an async iterable, with one value for each occurrence. This excerpt of `aircon.ts` declares an event:

```ts title="aircon.ts"
import { eventsFor } from "@acid-cat/core-ts";

const Status = z.object({ on: z.boolean(), celsius: z.number() }).meta({ id: "Status" });
const event = eventsFor<{ unit: Unit }>();

export const statusChanged = event({
  id: "aircon.status.changed",
  description: "The status of the unit changed.",
  audience: ["app", "mcp"],
  input: z.object({}),
  payload: Status,
  async *subscribe(_input, { context, signal }) {
    for await (const status of context.unit.changes(signal)) yield { data: status };
  },
});
```

The signal aborts when the subscription ends, however it ends. Release resources then.

## Write the catalog

```ts title="catalog.ts"
import { writeFile } from "node:fs/promises";
import { renderCatalog } from "@acid-cat/core-ts";

await writeFile("acidcat.catalog.json", renderCatalog(aircon, { toJsonSchema }));
```

`toJsonSchema` is the converter of your schema library, for example `z.toJSONSchema`.

## Serve each surface

| Function | Surface |
| --- | --- |
| `createSession(app, options)` | TypeScript: a handle for each capability and each event |
| `mcpHandler(app, options)` | MCP through HTTP: a web handler |
| `mcpStdioMain(app, options)` | MCP through stdio |
| `httpHandler(app, options)` | HTTP: a web handler |
| `cliMain(app, options)` | CLI |
| `installWebMcp(session)` | WebMCP tools in the page |
| `serve(handler, options)` from `@acid-cat/core-ts/node` | Serves the MCP and HTTP handlers on Node.js |

A web handler is a function from a `Request` to a `Response`.

### On Node.js

```ts title="serve.ts"
import { serve } from "@acid-cat/core-ts/node";

const mcp = mcpHandler(aircon, { name: "aircon", version: "1.0.0", allowedOrigins: [], toJsonSchema, context: { unit } });
const http = httpHandler(aircon, { allowedOrigins: [], toJsonSchema, context: { unit } });

const server = await serve({ "/mcp": mcp, "/": http }, { port: 3000 });
console.log(server.url); // http://127.0.0.1:3000
```

- `serve` takes one handler, or handlers by path prefix. The longest matching prefix wins. Give the MCP handler its own prefix, because it answers on every path.
- `hostname` is `127.0.0.1` by default. Use `0.0.0.0` or `::` to accept connections from the network.

::: caution
`serve` is plain HTTP/1.1. For network clients, end TLS on the platform in front of it, for example a load balancer or Cloudflare Tunnel.
:::

### MCP through stdio

```ts title="mcp.ts"
#!/usr/bin/env node
import { mcpStdioMain } from "@acid-cat/core-ts";

mcpStdioMain(aircon, { name: "aircon", version: "1.0.0", context: { unit }, toJsonSchema });
```

The process is one session with one context. Defects go to standard error. Never write to standard output from a capability.

### Typed calls in code

```ts
import { createSession } from "@acid-cat/core-ts";

await using session = createSession(aircon, { target: "app", context: { unit }, toJsonSchema });
const result = await session.call(powerSet, request.body); // validates an untrusted input
if (!result.ok) console.log(result.error._tag); // "Offline"

const power = session.handle(powerSet);
power.availability.subscribe(render);
await power.execute({ on: true });
```

`session.eventHandle(event)` gives a typed event handle. Its `subscribe` gives an async iterable of occurrences.

### WebMCP

This excerpt of `page.ts` registers the tools of a session:

```ts title="page.ts"
const session = createSession(app, { target: "app", context, toJsonSchema });
const webmcp = installWebMcp(session);
webmcp?.status.subscribe(({ phase, message }) => console.log(phase, message));
```

Use a session whose target has the `webmcp` surface. With no WebMCP host in the browser, `installWebMcp` returns `undefined`, and the page works without tools.

### A context for each request

`mcpHandler` and `httpHandler` take `context`, which all requests share, or `createContext(request)`, which makes one for each request. `createContext` can return `refuse(status, message, headers?)` to reject a request before any session opens. Use it to authenticate:

```ts
import { httpHandler, refuse } from "@acid-cat/core-ts";

const handler = httpHandler(aircon, {
  allowedOrigins: [],
  toJsonSchema,
  createContext: async (request) => {
    const caller = await accounts.caller(request.headers.get("Authorization"));
    if (caller === undefined) return refuse(401, "Give a valid token.", { "WWW-Authenticate": "Bearer" });
    return { unit, caller };
  },
});
```

## The command line

`cliMain` builds the command line of the target of the `cli` target:

```sh
node cli.ts aircon temperature set --celsius 22
node cli.ts aircon schedule set --days mon --days fri --hours 7 --hours 18
node cli.ts list
node cli.ts aircon power set --help
node cli.ts watch aircon.status.changed --cursor 41 --max-age-ms 300000
```

Declare aliases in the `cli` member of the `cli` target. `cliAlias(capabilityOrEvent, fixedInput?)` types the fixed input from the input schema, and `cliAliasDefault(…)` makes the default alias:

```ts
targets: {
  cli: {
    surfaces: ["cli"],
    cli: {
      aliases: {
        status: cliAlias(statusGet),
        "--on": cliAlias(powerSet, { on: true }),
        "--off": cliAlias(powerSet, { on: false }),
        fan: cliAlias(fanSet),
        "fan high": cliAlias(fanSet, { speed: "high" }),
      },
    },
  },
},
```

```sh
node cli.ts --on      # same as: node cli.ts aircon power set --on
node cli.ts fan high  # same as: node cli.ts aircon fan set --speed high
```

By default, the command line writes JSON only. The `output` option adds a human form, with output flags such as `--json` and formatters made by `cliFormat`. With `default: "auto"`, the human form is used on a terminal, and JSON in a pipe, in CI or under a coding agent.

`remote: httpClient(url)` makes the command line a client of the HTTP surface of a server. The commands still come from the local catalog of the target.

## Read more

- The full [`@acid-cat/core-ts` README](https://github.com/Hebilicious/acidcat/blob/main/packages/core-ts/README.md): every option, poll and webhook delivery, human output and application commands.
- [The air conditioner on the TypeScript core](/examples/core-ts/), in a code explorer.
- [Surfaces](/docs/concepts/surfaces/) and [the TypeScript surface](/spec/surfaces/typescript/).
