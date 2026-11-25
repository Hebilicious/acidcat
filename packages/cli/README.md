# @acid-cat/cli

The AcidCat command line, published on npm as `@acid-cat/cli`. It gives the `acid-cat` command, which checks catalogs and tests implementations. Run it at build time, in CI or by hand. Do not use it in an application at run time.

```sh
acid-cat check [--strict] [--output json] <catalog.json ...>  # check catalogs
acid-cat format [--write] <catalog.json ...>  # write catalogs in canonical form
acid-cat target <catalog.json> <target>       # write the catalog of one target
acid-cat conform --mcp <url> [--mcp-handshake] --mcp-stdio "<command>" --http <url> --cli "<command>" --webmcp <url> [--deadline <ms>] [--max-bytes <n>] [--output json]  # test an implementation
  [--poll-buffer <n>] [--poll-lease-mcp <url> --poll-lease-ms <ms>] [--webhook-principal <name> --webhook-cert <file> --webhook-key <file>]
  [--webhook-other-principal <name>] [--webhook-min-ttl-ms <ms>] [--webhook-max-ttl-ms <ms>] [--webhook-max-subscriptions <n>]
```

## Install

Install it as a development dependency, and run it with `pnpm exec acid-cat …`:

```sh
pnpm add -D @acid-cat/cli
```

It needs Node.js 24 or later. `acid-cat conform --webmcp <url>` also needs [Playwright](https://playwright.dev) and Chromium.

`acid-cat` ignores a first argument `--`, which package runners such as `pnpm` and `npx` pass to it: `pnpm acid-cat -- check` is `acid-cat check`.

## Output

`check` and `conform` take `--output human` (the default) or `--output json`. Human output is text for a person. JSON output is one JSON document on standard output, for a script or an agent, and nothing on standard error. The exit code is the same in both modes.

- `check`: `{ "conforms": boolean, "catalogs": [{ "file", "errors": [string], "warnings": [string] }] }`. `conforms` is `false` when the exit code is 1. A file that cannot be read, or that is not JSON, is a catalog with one error.
- `conform`: `{ "passed": number, "failed": number, "warnings": number, "checks": [{ "surface", "name", "rule", "passed", "warning"?, "detail"? }] }`. A check with a warning has `"passed": true` and `"warning": true`, and counts in both `passed` and `warnings`.

You get the JSON document only when the options are correct. With incorrect options, the exit code is 1, and standard output can hold the help text. `conform` writes one line of text to standard error, and nothing to standard output, when it gets no surface, only some of the `--webhook-*` options, or a certificate file that it cannot read.

## check

`check` tests a catalog against [`schemas/catalog.schema.json`](../../schemas/catalog.schema.json) and against the [catalog rules](../../spec/conformance.md#catalog) that the schema cannot express. It reports two levels:

- An **error** is a broken rule. Examples: an audience that names an unknown target, an event payload that is not an object, or an id that is both a capability and an event.
- A **warning** is a broken recommendation. Examples: a file that is not in [canonical form](../../spec/catalog.md#canonical-form), or a member with no `x-` prefix.

It also checks each alias in `options.cli` against the [alias rules](../../spec/surfaces/cli.md#aliases), and each `x-mcp-header` member in an input schema against the [header annotation rules](../../spec/surfaces/mcp.md#header-annotations) of MCP. An error about `x-mcp-header` names the capability or the event, and the location of the member as a JSON pointer into the bundled input schema.

The exit code is 1 with errors, and 0 otherwise. With `--strict`, warnings also give exit code 1.

## format

`format` writes a catalog in [canonical form](../../spec/catalog.md#canonical-form). Use it for catalogs that no catalog library wrote: Pkl output, generated files, or files you edit by hand. `--write` changes the files in place.

## target

`target` writes the [catalog of one target](../../spec/catalog.md#the-catalog-of-a-target): the capabilities, events and types that the target can use.

## conform

`conform` tests a running implementation of the [conformance fixture](conformance/fixture.pkl) through its surfaces. Each AcidCat core runs it in its tests.

### Options

Each flag has an equivalent option for `conform()` in code. Give one or more surfaces.

| Flag | In code | What it does |
| --- | --- | --- |
| `--mcp <url>` | `mcp` | Test the MCP surface through HTTP |
| `--mcp-handshake` | `mcpHandshake: true` | Also test the [`initialize` handshake of earlier revisions](../../spec/surfaces/mcp.md#earlier-revisions-through-http) through HTTP |
| `--mcp-stdio "<command>"` | `mcpStdio` | Test the MCP surface through stdio. Each check starts the server as a process |
| `--http <url>` | `http` | Test the HTTP surface. The URL is the base URL, before `/capabilities` |
| `--cli "<command>"` | `cli` | Test the CLI surface |
| `--webmcp <url>` | `webmcp` | Test the WebMCP surface on a page that serves the `app` target. In code, `webmcp` can also be a function that installs the implementation on a host in the same process |
| `--deadline <ms>` | `deadline` | The deadline of each check. The default is 30 000 |
| `--max-bytes <n>` | `maximumBytes` | The body limit of the remote surfaces, in bytes. The default is 1 048 576 |
| `--poll-buffer <n>` | `poll.bufferLimit` | The deployment's poll buffer size, from 1 to 97 |
| `--poll-lease-mcp <url>`, `--poll-lease-ms <ms>` | `pollLease: { mcp, leaseMs }` | An MCP server through HTTP with a poll lease time shorter than the deadline, and that lease time. Give both together |
| `--webhook-principal <name>`, `--webhook-cert <file>`, `--webhook-key <file>` | `webhook: { principal, cert, key }`, with the PEM text | Test webhook delivery. Give all three together |
| `--webhook-min-ttl-ms <ms>`, `--webhook-max-ttl-ms <ms>` | `webhook.minTtlMs`, `webhook.maxTtlMs` | The deployment's webhook lifetimes. The defaults are the specification's: 60 000 and 3 600 000 |
| `--webhook-max-subscriptions <n>` | `webhook.maxSubscriptions` | The deployment's limit of webhook subscriptions for one principal |
| `--webhook-other-principal <name>` | `webhook.otherPrincipal` | A second principal, for `Authorization: Bearer <name>` |
| `--output json` | | Write the result as JSON (see [Output](#output)) |

### What the checks test

[`acid-cat conform`](../../spec/conformance.md#acid-cat-conform) lists every check. In short:

- MCP through HTTP and stdio: The official MCP client tests the tools and outcomes with revision `2026-07-28`, and with the `initialize` handshake of `2025-11-25` through stdio, or through HTTP with `--mcp-handshake`. Raw requests test rejections. Through stdio, raw lines also test version negotiation, lines that are not JSON, a clean standard output and the end of standard input.
- HTTP and CLI: Each outcome, each kind of call failure, availability and rejections. For the CLI: each kind of flag, usage lines, help, shared prefixes, aliases, interrupts with exit code 130, and `watch --cursor`.
- WebMCP: The checks act as the host: they open the page in Chromium through [Playwright](https://playwright.dev) with a test `modelContext`. Install it first: `pnpm add -D playwright`, then `pnpm exec playwright install chromium`.
- Events: Through HTTP, MCP and the CLI: the list of events, failures before the first occurrence, each occurrence against `schemas/occurrence.schema.json` and its payload schema, order, `truncated`, the cursor, each end, and cancellation. Through WebMCP, no event is a tool.
- [Poll delivery](../../spec/surfaces/mcp.md#poll): Through MCP, when `events/list` gives `poll`. Otherwise the check gives a warning and `events/poll` must answer `Unsupported`. `--poll-buffer` adds a cursor older than the buffer. The lease time of `--mcp` and `--mcp-stdio` must be longer than the deadline, because a check uses a lease for its whole time. `--poll-lease-mcp` with `--poll-lease-ms` adds the end of an unused lease. Serve it from a second MCP server with a lease time shorter than the deadline, for example 1000.
- [Webhook delivery](../../spec/surfaces/mcp.md#webhook): Through MCP over HTTP, with the three `--webhook-*` options. The checks run an HTTPS receiver on `127.0.0.1` with that certificate. Configure the deployment to trust the certificate, allow deliveries to private addresses, and give the principal `<name>` to a request with `Authorization: Bearer <name>`. The deadline must be longer than the deployment's first retry wait, and the maximum lifetime must be longer than the deadline. Give `--webhook-other-principal` with `--webhook-max-subscriptions`: the limit check then fills a principal that no other check uses. Without the webhook options, a server that does not list `webhook` must answer `Unsupported`.
- [Server Card](../../spec/surfaces/mcp.md#server-card): Through MCP over HTTP, when `<mcp>/server-card` gives 200. The card must pass the JSON Schema of the Server Card extension, have one remote with the URL of `--mcp`, the version of `server/discover` and the revisions that the server serves, the CORS and cache headers, 304 for its `ETag`, 204 for `OPTIONS`, public signing keys only, and egress ranges in CIDR text. With the webhook options and signing keys in the card, each webhook request must have one `v1a,` signature for each key, and each must verify. The JSON Schema is `conformance/server-card.schema.json`, from commit `28db12c` of [ext-server-card](https://github.com/modelcontextprotocol/ext-server-card), under the Apache License 2.0 in `conformance/server-card.LICENSE`.
- [Hints](../../spec/surfaces/mcp.md#tools): Each MCP tool's annotations match its capability's hints.
- [Heartbeat](../../spec/surfaces/mcp.md#push): Through MCP with each transport, each `notifications/events/active` grants a `heartbeatMs`. A suggestion is clamped between 1000 and 60 000, a heartbeat comes no sooner than the grant after the request and before the deadline ([why](../../spec/conformance.md#the-silence-before-a-heartbeat)), and a suggestion that is not valid gets `-32602`.
- [Headers](../../spec/surfaces/mcp.md#headers): Through MCP over HTTP, a missing or wrong `Mcp-Method`, `Mcp-Name` or `Mcp-Param-*` header on `tools/call` and `events/stream` gets 400 and `-32020`, and a value in the base64 form is decoded, with a leading U+FEFF kept. Every request of conform mirrors the annotated arguments of the fixture (`fixture.switch.set` and `fixture.ticks`) into their headers.
- Properties: With fast-check, through MCP and HTTP: concurrent calls each get their own outcome, and a cancellation changes only its own call. Each run of a property has the deadline.

Each poll check uses a new key, so leases from an earlier run do not change the result.

### Waiting and deadlines

The checks wait for states they can observe, such as `fixture.held`, `fixture.watching` or a marker file, never for a fixed time. Each check has one deadline (`--deadline`, or `deadline` in code). A check that does not settle in time fails with "did not settle" and stops what it started, under a second deadline of the same length, so `conform` always returns. The deadline never makes a check pass.

### Result

A failed check of a SHOULD rule gives a warning, marked `!`, and passes. The exit code is 1 if a check fails.

### Use it in code

`conform()` and `serve()` come from `@acid-cat/cli`. Give `conform()` the signal of the test as `signal`, so that it stops when the test ends: each check that runs stops and kills the processes that it started, and no other check starts. This `serve()` is for tests only: it listens on `127.0.0.1`, on a free port, with plain HTTP. Like the servers of the cores, it closes no idle connection, so that a client of a test never sends a request on a connection while the server closes it. Its `close()` ends each idle connection at once, and ends each other connection when both its request and its response are complete, so it cuts no request that the server accepted. It resolves when every connection has ended, so a response that does not end, such as an open event stream, keeps it waiting. To serve an application, use its core's server: `serve` from `@acid-cat/core-ts/node`, `NodeServer` from `@acid-cat/core-effect`, or `remote::serve` from the crate `acid-cat-core`.

## Implementation

The command line is an [Effect](https://effect.website) program built on `effect/cli`. It validates catalogs with Effect Schema, and imports `schemas/catalog.schema.json` and each schema in the catalog as Effect schemas. The canonical writer comes from [`@acid-cat/catalog`](../catalog/typescript).

| File | Contents |
| --- | --- |
| `src/catalog.ts` | The catalog rules, the catalog of a target, and bundling |
| `src/main.ts` | The commands |
| `src/conform/` | The conformance checks, and `serve`, which serves web handlers on a local port for the tests |
| `conformance/` | The conformance fixture, in Pkl and in JSON |
| `test/` | Tests. Run them with `moon run cli:test` |
| `test/fixtures/` | The test catalog: a bakery, in canonical form, with capabilities and an event |
| `test/fixtures/rejected/` | Catalogs that `check` must reject, written by hand |
