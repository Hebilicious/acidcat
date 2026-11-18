# @acid-cat/cli

The AcidCat command line, published on npm as `@acid-cat/cli`. It gives the `acid-cat` command, which checks catalogs and tests implementations. Run it at build time, in CI or by hand. Do not use it in an application at run time.

```sh
acid-cat check [--strict] [--output json] <catalog.json ...>  # check catalogs
acid-cat format [--write] <catalog.json ...>  # write catalogs in canonical form
acid-cat view <catalog.json> <target>         # write the view of one target
acid-cat conform --mcp <url> [--mcp-handshake] --mcp-stdio "<command>" --http <url> --cli "<command>" --webmcp <url> [--deadline <ms>] [--max-bytes <n>] [--output json]  # test an implementation
  [--poll-buffer <n>] [--poll-lease-ms <ms>] [--webhook-principal <name> --webhook-cert <file> --webhook-key <file>]
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
- `conform`: `{ "passed": number, "failed": number, "warnings": number, "checks": [{ "binding", "name", "rule", "passed", "warning"?, "detail"? }] }`. A check with a warning has `"passed": true` and `"warning": true`, and counts in both `passed` and `warnings`.

You get the JSON document only when the options are correct. With incorrect options, the exit code is 1, and standard output can hold the help text. `conform` writes one line of text to standard error, and nothing to standard output, when it gets no binding, only some of the `--webhook-*` options, or a certificate file that it cannot read.

## check

`check` tests a catalog against [`schemas/catalog.schema.json`](../../schemas/catalog.schema.json) and against the [catalog rules](../../spec/conformance.md#catalog) that the schema cannot express. It reports two levels:

- An **error** is a broken rule. Examples: an audience that names an unknown target, an event payload that is not an object, or an id that is both a capability and an event.
- A **warning** is a broken recommendation. Examples: a file that is not in [canonical form](../../spec/catalog.md#canonical-form), or a member with no `x-` prefix.

`check` also gives an error when a capability hint (`readOnly`, `destructive` or `idempotent`) is not a boolean, and checks each alias in `options.cli` against the [alias rules](../../spec/bindings/cli.md#aliases).

The exit code is 0 with no errors and 1 with errors. With `--strict`, warnings also give exit code 1.

## format

`format` writes a catalog in canonical form. For example, it writes a capability's hints in the order `readOnly`, `destructive`, `idempotent`. Use it for catalogs that no catalog library wrote: Pkl output, generated files, or files you edit by hand.

## view

`view` writes the [view](../../spec/catalog.md#views) of one target: the capabilities and events that the target can use, and the types they use. A view with no events has no `events` member.

## conform

`conform` tests a running implementation of the [conformance fixture](conformance/fixture.pkl) through its bindings. The rules it tests are in [Conformance](../../spec/conformance.md#acid-cat-conform). Each AcidCat core runs `conform` in its tests.

### Options

Each flag has an equivalent option for `conform()` in code. Give one or more bindings.

| Flag | In code | What it does |
| --- | --- | --- |
| `--mcp <url>` | `mcp` | Test the MCP binding through HTTP |
| `--mcp-handshake` | `mcpHandshake: true` | Also test the [`initialize` handshake of earlier revisions](../../spec/bindings/mcp.md#earlier-revisions-through-http) through HTTP |
| `--mcp-stdio "<command>"` | `mcpStdio` | Test the MCP binding through stdio. Each check starts the server as a process |
| `--http <url>` | `http` | Test the HTTP binding. The URL is the base URL, before `/capabilities` |
| `--cli "<command>"` | `cli` | Test the CLI binding |
| `--webmcp <url>` | `webmcp` | Test the WebMCP binding on a page that serves the `app` target. In code, `webmcp` can also be a function that installs the implementation on a host in the same process |
| `--deadline <ms>` | `deadline` | The deadline of each check. The default is 30 000 |
| `--max-bytes <n>` | `maximumBytes` | The body limit of the remote bindings, in bytes. The default is 1 048 576 |
| `--poll-buffer <n>` | `poll.bufferLimit` | The deployment's poll buffer size, from 1 to 97 |
| `--poll-lease-ms <ms>` | `poll.leaseMs` | The deployment's poll lease time |
| `--webhook-principal <name>`, `--webhook-cert <file>`, `--webhook-key <file>` | `webhook: { principal, cert, key }`, with the PEM text | Test webhook delivery. Give all three together |
| `--webhook-min-ttl-ms <ms>`, `--webhook-max-ttl-ms <ms>` | `webhook.minTtlMs`, `webhook.maxTtlMs` | The deployment's webhook lifetimes. The defaults are the specification's: 60 000 and 3 600 000 |
| `--webhook-max-subscriptions <n>` | `webhook.maxSubscriptions` | The deployment's limit of webhook subscriptions for one principal |
| `--webhook-other-principal <name>` | `webhook.otherPrincipal` | A second principal, for `Authorization: Bearer <name>` |
| `--output json` | | Write the result as JSON (see [Output](#output)) |

### What the checks test

#### MCP through HTTP

- The official MCP client, with revision `2026-07-28`, tests the tools and outcomes. Raw requests test rejections.
- With `--mcp-handshake`, the client of revision `2025-11-25` tests the tools and outcomes again, and raw requests test `initialize` with no session and a notification.

#### MCP through stdio

- The official MCP client tests the tools and outcomes twice: with revision `2026-07-28`, and with the `initialize` handshake of revision `2025-11-25`. It also tests `notifications/tools/list_changed` and `notifications/cancelled`.
- Raw lines test the version negotiation, a line that is not JSON, that standard output holds only JSON-RPC messages, and the end of standard input.

#### HTTP and CLI

The checks test each outcome, each kind of call failure, availability, and rejections. For the CLI, they also test:

- Each kind of flag, including a repeated flag that gives one array item for each occurrence, or the whole array as JSON text.
- The usage line of each command and each event, with `[--cursor <string>] [--max-age-ms <integer>]`.
- The help of a command, an alias and an event: `Usage: ` and the usage, an empty line, then the description.
- The help of a shared prefix is its command list on standard output. A shared prefix alone, or with a flag that is not `--help`, writes the same list to standard error with exit code 2.
- An interrupt (`SIGINT`) during a call that holds gives exit code 130, and the call must end and delete its marker file.
- `watch --cursor` starts after the cursor. A `--max-age-ms` that is not an integer gives exit code 3.

#### WebMCP

The checks act as the WebMCP host. `--webmcp <url>` opens the page in Chromium, through [Playwright](https://playwright.dev), with a test `modelContext`. Install Playwright first: `pnpm add -D playwright`, then `pnpm exec playwright install chromium`.

#### Events

Through HTTP, MCP with each transport, and the CLI, the checks test:

- The list of the view's events.
- The call failures before the first occurrence: an event outside the view, and invalid input.
- Each occurrence against `schemas/occurrence.schema.json` and the payload schema, and the order of the occurrences.
- An occurrence with `truncated: true`, from `fixture.ticks` with `gap`. Through HTTP and the CLI, `truncated` is in the occurrence. Through MCP push, `notifications/events/active` has `truncated: true` and the cursor before the event. Through MCP poll, the result has `truncated: true`.
- The cursor, each end of a subscription (complete and `internal`), and cancellation.
- Through MCP: `server/discover`, `events/list` with the server's delivery modes, `notifications/events/active`, and the subscription id of each message. With `--mcp-handshake`, `initialize` must not declare the events extension.
- Through WebMCP: no event is a tool.

#### Poll delivery

The checks test poll delivery through MCP with each transport, when `events/list` gives `poll`. If it does not, the checks give a warning, and `events/poll` must answer `Unsupported`.

- Each row of the [Poll](../../spec/bindings/mcp.md#poll) table: no cursor, with no lease and with a lease; a cursor of the lease; a cursor of another lease, with and without a lease of the key; a cursor of push delivery; and a cursor of another lease that has a cursor of the provider, which resumes after it.
- The form of each result, `maxEvents` and `hasMore`, a `maxEvents` that is not valid, the failures before the first occurrence (which start no lease), and the error `-32603` after a defect.
- With `--poll-buffer <n>`: a cursor older than the buffer.
- With `--poll-lease-ms <ms>`: a lease with no poll ends and cancels its subscription. The lease time must be shorter than the deadline. A check makes other requests between two polls of a lease, so give a lease time of a few seconds, for example 5 seconds. A shorter lease can end between two polls on a busy computer, and the check then fails.
- Each check uses a new key in its input, so leases from an earlier run do not change the result.

#### Webhook delivery

The checks test webhook delivery through MCP over HTTP when they get the three options `--webhook-principal`, `--webhook-cert` and `--webhook-key`.

- The checks run an HTTPS receiver on `127.0.0.1` with this certificate. Configure the deployment under test to trust the certificate, allow deliveries to private addresses, and give the principal `<name>` to a request with the header `Authorization: Bearer <name>`.
- The checks test:
  - `Forbidden` with no principal
  - `-32602` for a URL that is not `https` and for a secret that is not valid
  - the verification and `challenge_failed`
  - the form of the `events/subscribe` result and its subscription id
  - the headers, signature and body of each delivery, and their order
  - a renewal that signs with the old and the new secret
  - `events/unsubscribe`, and a second `events/unsubscribe`
  - a retry with the same `webhook-id` after a status 500
  - a 410 that abandons a delivery
  - the control message `gap` with the watermark before an occurrence with `truncated: true`
  - the control message `terminated`
  - the lifetime that the server grants for a `ttlMs` below the minimum, above the maximum, `null` and absent
- The retry check waits for the deployment's first retry, so the deadline must be longer than that wait.
- With `--webhook-min-ttl-ms`, which must be shorter than the deadline, the checks also test that a subscription with no renewal ends at the end of its lifetime and gets no more deliveries.
- With `--webhook-max-subscriptions <n>`, the checks subscribe until the server answers `ResourceExhausted` (`-32025`, with `data: { limit: "subscriptions", max }`), then renew one subscription.
- With `--webhook-other-principal <name>`, the limit check fills the subscriptions of this second principal, which no other check uses. It expects exactly `n` subscriptions, then tests that the first principal can still subscribe. Without it, the limit check uses the first principal, which can still hold subscriptions from other checks.
- Without the webhook options, a server that does not list `webhook` must answer `events/subscribe` and `events/unsubscribe` with `Unsupported`. Through stdio, it must always do so.

#### Hints

Through MCP with each transport, each tool's `readOnlyHint`, `destructiveHint` and `idempotentHint` match its capability's `readOnly`, `destructive` and `idempotent`. When a capability has no hint, the tool has no annotation or the MCP default.

#### Properties

With fast-check, through MCP with each transport and through HTTP: concurrent calls each get exactly their own outcome, and a cancellation changes only its own call.

### Waiting and deadlines

The checks wait for states they can observe, never for a fixed time.

- Before a check cancels a call to `fixture.hold`, it waits until `fixture.held` gives the call's key or, for the CLI, until the call's marker file exists.
- Before a check signals or cancels a subscription to `fixture.watch`, it waits until `fixture.watching` gives its key, or until its marker file exists. After it cancels the subscription, it waits until the key leaves `fixture.watching`.
- Through the CLI, after the process exits, the check waits until the marker file of the call or subscription is deleted. A core can exit with 130 when a call does not stop, so the exit code alone does not show that the call ended.

Each check has one deadline: `--deadline`, or `deadline` in code, in milliseconds. A check that does not settle before its deadline fails with "did not settle", and the check stops what it started. That cleanup has a deadline of the same length, so `conform` always returns. The deadline never makes a check pass.

### Result

A failed check of a recommendation (SHOULD) gives a warning, marked `!`, and passes. The exit code is 1 if a check fails.

### Use it in code

`conform()` and `serve()` come from `@acid-cat/cli`, and `createTestHost()` gives the WebMCP host that the checks use. This `serve()` is for tests only: it listens on `127.0.0.1`, on a free port, with plain HTTP. To serve an application, use its core's server: `serve` from `@acid-cat/core-ts/node`, `NodeServer` from `@acid-cat/core-effect`, or `remote::serve` from the crate `acid-cat-core`.

## Implementation

The command line is an [Effect](https://effect.website) program built on `effect/cli`. It validates catalogs with Effect Schema, and imports `schemas/catalog.schema.json` and each schema in the catalog as Effect schemas. The canonical writer comes from [`@acid-cat/catalog`](../catalog/typescript).

| File | Contents |
| --- | --- |
| `src/catalog.ts` | The catalog rules, views and bundling |
| `src/main.ts` | The commands |
| `src/conform/` | The conformance checks, and `serve`, which serves web handlers on a local port for the tests |
| `conformance/` | The conformance fixture, in Pkl and in JSON |
| `test/` | Tests. Run them with `moon run cli:test` |
| `test/fixtures/` | The test catalog: a bakery, in canonical form, with capabilities and an event |
| `test/fixtures/rejected/` | Catalogs that `check` must reject, written by hand |
