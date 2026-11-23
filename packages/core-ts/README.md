# @acid-cat/core-ts

`@acid-cat/core-ts` is an AcidCat core in plain TypeScript. You define capabilities and events once, and the package serves them through the TypeScript, HTTP, MCP, CLI and WebMCP bindings. It is one implementation of the [AcidCat specification](../../spec/README.md).

Use it if you want AcidCat without Effect. A capability is an async function, and an event is an async iterable. Validate inputs with any [Standard Schema](https://standardschema.dev) library, such as Zod, Valibot or ArkType. The application writes its own catalog from its code.

```sh
pnpm add @acid-cat/core-ts
```

## Quick start

A command line with one command:

```ts
import { cliMain, defineApp, defineCapability, ok } from "@acid-cat/core-ts";
import type { ToJsonSchema } from "@acid-cat/core-ts";
import { z } from "zod";

const lamp = { on: false };

const powerSet = defineCapability({
  id: "lamp.power.set",
  description: "Turn the lamp on or off.",
  audience: ["cli"],
  input: z.object({ on: z.boolean() }),
  output: z.object({ on: z.boolean() }),
  run: ({ on }) => {
    lamp.on = on;
    return ok({ on });
  },
});

const app = defineApp({
  title: "Desk lamp",
  targets: { cli: { bindings: ["cli"] } },
  capabilities: [powerSet],
});

const toJsonSchema: ToJsonSchema = (schema) => {
  if (!(schema instanceof z.ZodType)) throw new Error("Only Zod schemas.");
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
};

cliMain(app, { name: "lamp", version: "0.1.0", context: {}, toJsonSchema });
```

```sh
$ node lamp.ts lamp power set --on
{
  "on": true
}
```

To serve the same app over HTTP or MCP, add those bindings to a target and pass the app to `httpHandler` or `mcpHandler`. See [Serve capabilities and events](#serve-capabilities-and-events).

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

No type parameter is required: the types come from the schemas. The only one you may give is the context type, when capabilities need a service from outside, such as `unit` in the example above. `capabilitiesFor<Context>()` sets it once for all capabilities, and the same `Context` goes to `defineApp<Context>`. The context itself comes from the `context` option of `cliMain`, `httpHandler` and the other entry points.

- `run(input, { signal, context, target })` gets the decoded input (`{}` without an input schema), an `AbortSignal`, the context, and the session's target.
- `run` returns `ok(value)` or `fail(failure)`. The types check the value against the output schema and the failure against `failures`. A failure schema describes the whole object, `_tag` included. If `run` throws, the call fails as `internal`.
- `readOnly`, `destructive` and `idempotent` are optional [hints](../../spec/catalog.md#capabilities).
- `availability` is an optional function that returns an observable. The session reads it with `getSnapshot` when a call arrives, and subscribes only while something listens.
- `state` is an optional `{ schema, source }` for [state](../../spec/invocation.md#state). The handle exposes it as `snapshot`.
- `run`, `availability` and `state` get the same `Context`.
- `defineCapability` and `capabilitiesFor` keep the literal type of `id`. An application lists only capabilities made by them.

## Write events

An [event](../../spec/events.md) is a kind of thing that happens, which clients can follow. `subscribe` returns an async iterable with one value per occurrence.

```ts
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

export const aircon = defineApp<{ unit: Unit }>({ targets, capabilities: [powerSet], events: [statusChanged] });
```

- `subscribe(input, { signal, context, target, cursor, maxAgeMs })`. The signal aborts when the subscription ends, however it ends. Release resources then.
- Each value is `{ data }`, with optional `eventId`, `timestamp`, `cursor` and `truncated`. The session fills in a missing `eventId` and `timestamp` as [Occurrences](../../spec/events.md#occurrences) says. With no payload schema, `data` is `{}`.
- If `subscribe` or the iterable throws, or `data` does not match the payload schema, the subscription fails as `internal` and the details go to `onDefect`.
- The session asks for the first value before the `subscribe` promise resolves, so an async generator runs to its first `await` or `yield` first. Register a listener on the source before that point to see every change after `subscribe` resolves.
- To support [resuming](../../spec/events.md#resuming), give a `cursor` with each value and honor the `cursor` and `maxAgeMs` you receive.
- `defineEvent` and `eventsFor` keep the literal type of `id`. Capabilities and events share one set of ids.

## Write the catalog

```ts
import { writeFile } from "node:fs/promises";
import { renderCatalog } from "@acid-cat/core-ts";

const toJsonSchema = (schema) => z.toJSONSchema(schema, { target: "draft-2020-12" });
await writeFile("acidcat.catalog.json", renderCatalog(aircon, { toJsonSchema })); // canonical form
```

Standard Schema has no JSON Schema conversion, so pass your schema library's converter as `toJsonSchema`.

## Serve capabilities and events

| Function | Binding | Result |
| --- | --- | --- |
| `createSession(app, options)` | [TypeScript](../../spec/bindings/typescript.md) | A session with a handle per capability and an event handle per event |
| `mcpHandler(app, options)` | [MCP](../../spec/bindings/mcp.md#http) over HTTP | `(request: Request) => Promise<Response>` |
| `mcpHandshake(handler)` | [MCP](../../spec/bindings/mcp.md#earlier-revisions-through-http), earlier revisions | The handler, plus the `initialize` handshake. From [`@acid-cat/mcp-handshake`](../mcp-handshake) |
| `mcpStdioMain(app, options)`, `runMcpStdio(…)` | [MCP](../../spec/bindings/mcp.md#stdio) over stdio | The process's MCP server, or a promise that resolves when the input ends |
| `httpHandler(app, options)` | [HTTP](../../spec/bindings/http.md) | `(request: Request) => Promise<Response>` |
| `cliMain(app, options)`, `runCli(…)` | [CLI](../../spec/bindings/cli.md) | The process's command line, or an exit code |
| `httpClient(url, options)` | [CLI](../../spec/bindings/cli.md#server) | A client for a server's HTTP binding |
| `installWebMcp(session)` | [WebMCP](../../spec/bindings/webmcp.md) | Tools in the page, with a status |
| `serve(handler, options)` from `@acid-cat/core-ts/node` | MCP and HTTP | A Node.js server. See [Serve on Node.js](#serve-on-nodejs) |

Options that tune event delivery:

| Option | Of | Default | Meaning |
| --- | --- | --- | --- |
| `bufferLimit` | `createSession`, `httpHandler`, `mcpHandler`, `runMcpStdio` | 256 | Occurrences kept per subscription for a [slow client](../../spec/events.md#slow-clients) |
| `keepaliveMs` | `httpHandler` | 15 seconds | Idle time before a comment line on an event stream |
| `heartbeatMs` | `mcpHandler`, `runMcpStdio` | 15 seconds | Heartbeat interval of `events/stream` when the request suggests none. A suggestion in `params.heartbeatMs` gets a grant from 1 to 60 seconds ([Push](../../spec/bindings/mcp.md#push)) |
| `clock` | `mcpHandler`, `runMcpStdio`, `webhookDelivery` | System clock | Time and timers for leases, lifetimes and retries. Tests pass their own |

### MCP poll and webhook delivery

`mcpHandler` and `runMcpStdio` serve [poll](../../spec/bindings/mcp.md#poll) delivery. Over HTTP, a lease's session gets the context of the request that started it; over stdio, the process's context. Leases live in memory. `handler.close()` (or `await using`) ends every lease and webhook subscription; over stdio, the end of standard input does.

| `poll` option | Default | Meaning |
| --- | --- | --- |
| `leaseMs` | 5 minutes | Time without a poll before a lease ends |
| `bufferLimit` | 1000 | Occurrences each lease keeps |
| `maxEvents` | 100 | Occurrences per result when the request gives no `maxEvents` |
| `nextPollMs` | 2000 | The `nextPollMs` of each result |

The `principal(request)` option of `mcpHandler` returns the client's identity, such as a verified token's subject, or `undefined`. It is part of each lease key and webhook subscription key, so one client cannot read another's lease. Over stdio, leases have no principal.

[Webhook](../../spec/bindings/mcp.md#webhook) delivery is off by default and works only over HTTP. Enable it with the `webhooks` option and `webhookDelivery(options)` from `@acid-cat/core-ts/node`. It needs `principal`.

```ts
import { mcpHandler } from "@acid-cat/core-ts";
import { serve, webhookDelivery } from "@acid-cat/core-ts/node";

const mcp = mcpHandler(aircon, {
  name: "aircon",
  version: "1.0.0",
  allowedOrigins: [],
  toJsonSchema,
  context: { unit },
  principal: (request) => verifiedSubject(request), // string | undefined
  webhooks: webhookDelivery({ maxTtlMs: 3_600_000 }),
});
await serve({ "/mcp": mcp });
```

| `webhookDelivery` option | Default | Meaning |
| --- | --- | --- |
| `allow(url)` | None | The allowlist. A URL for which it returns `true` skips verification |
| `allowPrivateNetworks` | `false` | Also connect to addresses that are not globally routable. For tests and private networks only |
| `ca` | None | Extra certificate authorities to trust, in PEM form |
| `maxTtlMs`, `minTtlMs` | 1 hour, 1 minute | Bounds on the granted lifetime |
| `maxSubscriptions` | 100 | Webhook subscriptions per principal |
| `attempts`, `retryWindowMs` | 5, 15 minutes | Attempts per delivery, and their time window |
| `retryDelayMs(attempt)` | 10 s, 30 s, 90 s, 270 s | The wait before the next attempt |
| `timeoutMs` | 5 seconds | Wait for each response |
| `rotationGraceMs` | 5 minutes | How long the old secret still signs after a new one |

Verifications are kept in memory while the process runs. The server checks the endpoint's TLS certificate, never logs or returns a secret, and never passes on the endpoint's response text: `lastError` and `CallbackEndpointError` carry only a category such as `http_4xx`.

### Serve on Node.js

`@acid-cat/core-ts/node` serves web handlers on Node.js with `node:http` and no other dependency.

```ts
import { serve } from "@acid-cat/core-ts/node";

const mcp = mcpHandler(aircon, { name: "aircon", version: "1.0.0", allowedOrigins: [], toJsonSchema, context: { unit } });
const http = httpHandler(aircon, { allowedOrigins: [], toJsonSchema, context: { unit } });

const server = await serve({ "/mcp": mcp, "/": http }, { port: 3000 });
console.log(server.url); // http://127.0.0.1:3000
```

- `serve` takes one handler, or handlers by path prefix. The longest matching prefix wins, and `/` matches every path. The MCP handler answers on every path, so give it its own prefix. No match gets `404`; a handler that rejects gets `500`.
- `port` defaults to `3000`; `0` picks a free port (read it from `server.port`). `hostname` defaults to `127.0.0.1`; use `0.0.0.0` or `::` to accept network connections.
- `serve` resolves once the server listens. `server.close()` or `await using` stops it. A closed client connection aborts the request's signal, which cancels the call.

`serve` is plain HTTP/1.1. For network clients, terminate TLS on the platform in front of it (a load balancer, a Kubernetes ingress, Cloudflare Tunnel) and set `hostname` so the platform can connect. For in-process HTTPS, HTTP/2, middleware, or Bun and Deno, give the handler to a library such as [srvx](https://srvx.h3.dev). Check that it aborts the request's signal when the client disconnects, or calls are not cancelled.

### MCP over stdio

```ts
#!/usr/bin/env node
import { mcpStdioMain } from "@acid-cat/core-ts";

mcpStdioMain(aircon, { name: "aircon", version: "1.0.0", context: { unit }, toJsonSchema });
```

The process is one session with one `context`, and behaves as [Stdio](../../spec/bindings/mcp.md#stdio) says. It also serves the `initialize` handshake of `2025-06-18`. Defects go to standard error, so never write to standard output from a capability. `runMcpStdio(app, options, { input, write })` runs the same server on any stream in any runtime: `input` is an async iterable of bytes or text, and `write` writes one line.

### Typed calls and handles

`createSession` returns a `Session<Context>`, which is async-disposable. Both typed entry points take the capability object, so the types come from its schemas:

- `session.call(capability, input)` validates an untrusted input. A mismatch rejects as `invalid-input`.
- `session.handle(capability)` returns its [handle](../../spec/bindings/typescript.md#handles): `availability`, `snapshot`, and `execute` for an input the types already check.

The session must serve that exact object. Any other capability, even with the same id, rejects as `unknown-capability` and its handle is unavailable. `session.handles` maps ids to handles for bindings; their input type is `never`, so call them with `invokeExternal`.

```ts
import { createSession } from "@acid-cat/core-ts";

await using session = createSession(aircon, { target: "app", context: { unit }, toJsonSchema });
const result = await session.call(powerSet, request.body); // Result<null, { readonly _tag: "Offline"; since?: string }>
if (!result.ok) console.log(result.error._tag); // "Offline"

const power = session.handle(powerSet);
power.availability.subscribe(render);
await power.execute({ on: true });
```

### Event handles

`session.eventHandle(event)` returns a typed [event handle](../../spec/bindings/typescript.md#event-handles). `session.eventHandles` maps ids to event handles for bindings; call them with `subscribeExternal`. Failures reject with a `CallFailureError`.

```ts
const status = session.eventHandle(statusChanged);
for await (const occurrence of await status.subscribe({})) {
  render(occurrence.data); // { on: boolean; celsius: number }
}
```

For a GraphQL subscription, return the `subscribe` promise from the field's `subscribe` resolver:

```ts
subscription: { statusChanged: { subscribe: () => status.subscribe({}), resolve: (occurrence) => occurrence.data } }
```

### WebMCP

`installWebMcp(session, { host })` registers the session's available capabilities as [WebMCP](../../spec/bindings/webmcp.md) tools. Use a session whose target has the `webmcp` binding. Without `host`, it calls `findHost()`. With no host, it returns `undefined` and the page works without tools.

```ts
const session = createSession(app, { target: "app", context, toJsonSchema });
const webmcp = installWebMcp(session);
webmcp?.status.subscribe(({ phase, message }) => console.log(phase, message));
```

The result has `status` (an observable of the [status](../../spec/bindings/webmcp.md#status)), `retry()` for the last failed update, and `dispose()`, which removes all tools and waits for calls in progress. [`examples/aircon/core-ts/page.ts`](../../examples/aircon/core-ts/page.ts) is a page with tools; `acid-cat conform --webmcp <url>` tests a page that serves the conformance fixture.

### Context per request

`mcpHandler` and `httpHandler` take `context`, shared by all requests, or `createContext(request)`, which makes one per request. Use `createContext` when requests must not share objects, as on Cloudflare Workers. The handler disposes a context that has `Symbol.asyncDispose` or `Symbol.dispose` after the response, or after the stream ends. Over MCP, a context that started a poll lease or webhook subscription lives until those end too.

`createContext` can return `refuse(status, message, headers?)` instead, to reject the request before any session opens. Use it to authenticate:

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

- The response has the refusal's status and headers and the JSON body `{ "message" }`. Keep internal data out of the message.
- The status must be 400 to 599; otherwise `refuse` throws a `RangeError`. `isRefusal(value)` tests for a refusal.
- On `mcpHandler`, also set `principal` from the same caller. Without it, two callers that poll the same event with the same input share one lease.
- The command line and MCP over stdio have one context for the whole program.

### Command line

`cliMain` builds the command line of the `cli` target's view as the [CLI binding](../../spec/bindings/cli.md) defines it: [commands, flags, usage and help](../../spec/bindings/cli.md#commands), [`watch`](../../spec/bindings/cli.md#events), [exit codes](../../spec/bindings/cli.md#outcomes) and [aliases](../../spec/bindings/cli.md#aliases). `runCli` is the same without a process: it returns the exit code. A command line that breaks a binding rule makes `runCli` reject, and `cliMain` write the error and exit with 5.

```sh
node cli.ts aircon temperature set --celsius 22
node cli.ts aircon schedule set --days mon --days fri --hours 7 --hours 18
node cli.ts list
node cli.ts aircon power set --help
node cli.ts watch aircon.status.changed --cursor 41 --max-age-ms 300000
```

After an interrupt (`SIGINT`), `cliMain` waits one second (`INTERRUPT_GRACE_MS` from `@acid-cat/spec-ts`) for the call or subscription to end, then exits with 130.

#### Application commands

The `commands` option adds your own commands. A command has a `name`, a `description` for the help, and `run(args, io)`. `run` gets the arguments after the name and `io` with `stdout`, `stderr`, `signal`, `output` and `context`, and returns the exit code. The names follow the [rules for application commands](../../spec/bindings/cli.md#commands). The `description` option sets the text at the top of the help; the default is the application's description, then its title, then the program name.

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

#### Aliases

Declare [aliases](../../spec/bindings/cli.md#aliases) in the `cli` member of the `cli` target. `cliAlias(capabilityOrEvent, fixedInput?)` types the fixed input from the input schema, and `cliAliasDefault(…)` makes the default alias. The catalog writes them in `options.cli`.

```ts
targets: {
  cli: {
    bindings: ["cli"],
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
node cli.ts status    # same as: node cli.ts aircon status get
node cli.ts fan high  # same as: node cli.ts aircon fan set --speed high
```

#### Human output

In the JSON form, a result, a failure and the output of `list` are one line of JSON when standard output is not a terminal, and have an indent of 2 on a terminal. `cliMain` sets `io.pretty` from standard output. `runCli` writes one line unless `io.pretty` is `true`.

Without the `output` option, the command line writes JSON only, even on a terminal. The `output` option adds a human form:

- `flags`: the output flags. Each has `names` (`--word`, or `-x` with one letter or digit) and either `form: "human" | "json"` for a switch, or `values` that map each value to a form. An output flag can appear anywhere before a later `--`; for an application command it comes before the command name, and `io.output` holds the form. The last output flag wins. A missing or unknown value exits with 3.
- `default`: `"json"` (the default) or `"auto"`. With `"auto"`, `cliMain` picks the human form when standard output is a terminal, `CI` is not set, and no coding agent is detected. `runCli` takes the form from `io.output`.
- `formats`: formatters made by `cliFormat`.

The agent variables are `AI_AGENT`, `CLAUDECODE`, `CODEX_THREAD_ID`, `CURSOR_AGENT`, `GEMINI_CLI`, `OPENCODE`, `AMP_CURRENT_THREAD_ID`, `AUGMENT_AGENT`, `QWEN_CODE_SESSION_ID`, `PI_CODING_AGENT`, `CRUSH` and `COPILOT_AGENT`. One counts as set unless it is empty, `0`, `false`, `no` or `off`.

An output flag name must be valid, unique, and not collide with `--help`, `--version`, `--cursor`, `--max-age-ms`, a flag alias, or an input flag in the view. `-h` is allowed: `--help` still prints the help. Colors appear only on a terminal without `NO_COLOR`.

The human form changes only how output looks; exit codes, streams, help and `--version` stay the same:

- A value or a failure goes through its formatter, or the generic layout. A `null` value prints nothing.
- A call failure prints `error (<kind>): <message>` on standard error.
- `watch` prints one block per occurrence, preceded by `(some occurrences were lost)` when `truncated` is set.
- `list` prints each command with its description.
- The generic layout prints `key  value` lines for scalars, an indented block for nested members, arrays of scalars joined with `, `, arrays of flat objects as a table, and other arrays as a `- ` list.

`cliFormat(capabilityOrEvent, formatter)` types the value, each failure and the payload from the schemas. The formatter gets the decoded value and `ui`: `bold`, `dim`, `ok`, `warn`, `error`, and `table(header, rows)`. If decoding fails or the formatter throws, the generic layout is used. Two formats for one id, or a format outside the view, make `runCli` reject.

```ts
import { cliFormat, cliMain } from "@acid-cat/core-ts";
import type { CliUi } from "@acid-cat/core-ts";

const statusText = (status: z.infer<typeof Status>, ui: CliUi) => `${ui.bold(status.power ? "on" : "off")} · ${status.mode}`;

cliMain(aircon, {
  name: "aircon",
  version: "0.1.0",
  context: { unit },
  toJsonSchema,
  output: {
    flags: [
      { names: ["--format", "-f"], values: { text: "human", json: "json" } },
      { names: ["--json"], form: "json" },
    ],
    formats: [
      cliFormat(statusGet, { value: statusText, failures: { Offline: (_, ui) => ui.error("offline") } }),
      cliFormat(statusChanged, statusText),
    ],
  },
});
```

```sh
node cli.ts aircon status get --format text   # off · cool
node cli.ts aircon status get --json          # {"power":false,"mode":"cool",…}
```

### Remote command line

Pass `remote: httpClient(url, { headers?, fetch? })` to `cliMain` or `runCli` to drive a view on a server through its HTTP binding, as [Server](../../spec/bindings/cli.md#server) describes. Commands, flags and help still come from the local view. `httpClient` throws if the URL is not `http` or `https`, or has credentials, a query or a fragment, or if a header is invalid; the error never contains a header value.

Serve the HTTP binding with the command line's target, as [`examples/aircon/core-ts/serve.ts`](../../examples/aircon/core-ts/serve.ts) does. [`examples/aircon/core-ts/cli.ts`](../../examples/aircon/core-ts/cli.ts) sends to it when `AIRCON_URL` is set:

```ts
// On the server.
serve({ "/cli": httpHandler(aircon, { allowedOrigins: [], target: "cli", base: "/cli", context: { unit }, toJsonSchema }) }, { hostname: "0.0.0.0", port: 8080 });

// In the command line.
cliMain(aircon, { name: "aircon", version: "0.1.0", context: { unit: new Unit() }, toJsonSchema, remote: httpClient("http://pi.local:8080/cli", { headers: { Authorization: `Bearer ${token}` } }) });
```

The client also works alone: `capabilities()`, `invoke(id, input, { signal })` and `subscribe(id, input, { signal, cursor, maxAgeMs })`. No method rejects; each returns the call failure.

## Examples and tests

- [`examples/aircon/core-ts`](../../examples/aircon/README.md) is an air conditioner built with this package. [`examples/aircon/apis`](../../examples/aircon/README.md#apis) builds GraphQL, Cap'n Web and Elysia APIs on it.
- `moon run core-ts:test` tests sessions, handles and every binding, and runs `acid-cat conform` against every binding. The test applications are in `test/`:
  - [`test/fixture.ts`](test/fixture.ts) has one capability per behavior that `acid-cat conform` tests.
  - [`test/kettle.ts`](test/kettle.ts) is an in-memory kettle: catalog, named types, state, availability and typed handles.
  - [`test/sensors.ts`](test/sensors.ts) is a set of in-memory sensors: events through each binding, slow clients, cursors, and a GraphQL subscription.
