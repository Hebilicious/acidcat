# @acid-cat/cli

The AcidCat command line. npm package: `@acid-cat/cli`. It gives the `acid-cat` command. Use it at build time, in CI or by hand, to check catalogs and to test implementations. Do not use it in an application at run time.

```sh
acid-cat check [--strict] <catalog.json ...>  # check catalogs
acid-cat format [--write] <catalog.json ...>  # write catalogs in canonical form
acid-cat view <catalog.json> <target>         # write the view of one target
acid-cat conform --mcp <url> [--mcp-handshake] --mcp-stdio "<command>" --http <url> --cli "<command>" --webmcp <url> [--deadline <ms>]  # test an implementation
  [--poll-buffer <n>] [--poll-lease-ms <ms>] [--webhook-principal <name> --webhook-cert <file> --webhook-key <file>]
```

Install it as a development dependency, and run it with `pnpm exec acid-cat …`:

```sh
pnpm add -D @acid-cat/cli
```

It needs Node.js 24 or later. `acid-cat conform --webmcp <url>` also needs [Playwright](https://playwright.dev) and Chromium.

## check

`check` tests a catalog against [`schemas/catalog.schema.json`](../../schemas/catalog.schema.json) and against the [catalog rules](../../spec/conformance.md#catalog) that the schema cannot express.

- An **error** is a broken rule. Examples: an audience that names an unknown target, an event payload that is not an object, or an id that is both a capability and an event.
- A **warning** is a broken recommendation. Examples: a file that is not in [canonical form](../../spec/catalog.md#canonical-form), or a member with no `x-` prefix.

The exit code is 0 if there are no errors. It is 1 if there are errors. With `--strict`, warnings also give the exit code 1.

## format

`format` writes a catalog in canonical form. Use it for catalogs that a catalog library did not write: Pkl output, generated files, or files that you edit by hand.

## view

`view` writes the [view](../../spec/catalog.md#views) of one target: the capabilities and the events that the target can use, and the types that they use. A view with no events has no `events` member.

## conform

`conform` tests a running implementation of the [conformance fixture](conformance/fixture.pkl) through its bindings (see [Conformance](../../spec/conformance.md#acid-cat-conform)):

- **MCP through HTTP:** `--mcp <url>`. The official MCP client, with revision `2026-07-28`, for tools and outcomes; raw requests for rejections. With `--mcp-handshake`, or `mcpHandshake: true` in code, the checks also test the [`initialize` handshake of earlier revisions](../../spec/bindings/mcp.md#earlier-revisions-through-http): the client of revision `2025-11-25` tests the tools and outcomes again, and raw requests test `initialize` with no session and a notification.
- **MCP through stdio:** `--mcp-stdio "<command>"`, or `mcpStdio` in code. The checks start the server as a process. The official MCP client tests the tools and outcomes two times: with revision `2026-07-28`, and with the `initialize` handshake of revision `2025-11-25`. It also tests `notifications/tools/list_changed` and `notifications/cancelled`. Raw lines test the version negotiation, a line that is not JSON, a standard output with only JSON-RPC messages, and the end of standard input.
- **HTTP** and **CLI:** each outcome, each kind of call failure, availability, and rejections. For the CLI, also each kind of flag, including a repeated flag that gives one item of an array for each occurrence, or the whole array as JSON text, and the usage line of each command and of each event, with `[--cursor <string>] [--max-age-ms <integer>]`. An interrupt (`SIGINT`) during a call that holds gives exit code 130. `watch --cursor` starts after the cursor, and a `--max-age-ms` that is not an integer gives exit code 3.
- **WebMCP:** the checks act as the WebMCP host. `--webmcp <url>` opens a page that serves the `app` target in Chromium, through [Playwright](https://playwright.dev), with a test `modelContext`. Install Playwright to use it: `pnpm add -D playwright`, then `pnpm exec playwright install chromium`. In code, `webmcp` can also be a function that installs the implementation on a host in the same process.
- **Events:** through HTTP, MCP with each transport, and the CLI. The checks examine the list of the events of the view, the call failures before the first occurrence (an event outside the view, and invalid input), each occurrence against `schemas/occurrence.schema.json` and the payload schema, the order of the occurrences, the cursor, each end of a subscription (complete and `internal`), and cancellation. Through MCP, they also examine `server/discover`, `events/list` with the delivery modes of the server, `notifications/events/active`, and the subscription id of each message. With `--mcp-handshake`, `initialize` must not declare the events extension. Through WebMCP, no event is a tool.
- **Poll delivery:** through MCP with each transport, when `events/list` gives `poll`. If not, the checks give a warning, and `events/poll` must answer `Unsupported`. The checks test each row of the table of [Poll](../../spec/bindings/mcp.md#poll): no cursor with no lease and with a lease, a cursor of the lease, a cursor of another lease with and without a lease of the key, a cursor of push delivery, and a cursor of another lease that has a cursor of the provider, which resumes after it. They also test the form of each result, `maxEvents` and `hasMore`, a `maxEvents` that is not valid, the failures before the first occurrence, which start no lease, and the error `-32603` after a defect. With `--poll-buffer <n>`, or `poll.bufferLimit` in code, they test a cursor older than the buffer: `n` is the buffer size of the deployment, from 1 to 97. With `--poll-lease-ms <ms>`, or `poll.leaseMs`, they test that a lease with no poll ends, and cancels its subscription. The lease time must be shorter than the deadline. Each check uses a new key in its input, so the leases of an earlier run do not change the result.
- **Webhook delivery:** through MCP over HTTP, with `--webhook-principal <name>`, `--webhook-cert <file>` and `--webhook-key <file>` together, or `webhook: { principal, cert, key }` in code, with the PEM text. The checks run an HTTPS receiver on `127.0.0.1` with this certificate. Configure the deployment under test for the test: it trusts the certificate, allows deliveries to private addresses, and gives the principal `<name>` to a request with the header `Authorization: Bearer <name>`. The checks test `Forbidden` with no principal, `-32602` for a URL that is not `https` and for a secret that is not valid, the verification and `challenge_failed`, the form of the result of `events/subscribe` and its subscription id, the headers, the signature and the body of each delivery, the order of the deliveries, a renewal that signs with the old and the new secret, `events/unsubscribe` and a second `events/unsubscribe`, a retry with the same `webhook-id` after a status 500, a 410 that abandons a delivery, and the control message `terminated`. The retry check waits for the first retry of the deployment, so the deadline must be longer than that wait. Without these options, a server that does not list `webhook` must answer `events/subscribe` and `events/unsubscribe` with `Unsupported`. Through stdio, it must always do so.
- **Properties:** with fast-check, through MCP with each transport and through HTTP: concurrent calls each get exactly their own outcome, and a cancellation changes only its own call.

The checks wait for states that they can observe, not for times. Before a check cancels a call to `fixture.hold`, it waits until `fixture.held` gives the key of the call, or, for the CLI, until the marker file of the call exists. In the same way, before a check signals or cancels a subscription to `fixture.watch`, it waits until `fixture.watching` gives its key, or until its marker file exists. After it cancels the subscription, it waits until the key leaves `fixture.watching`. Each check has one deadline: `--deadline`, or `deadline` in code, in milliseconds. The default is 30 000. A check that does not settle before its deadline fails with "did not settle", and the check stops what it started. This cleanup has a deadline of the same length, so `conform` always returns. The deadline never makes a check pass.

A check of a recommendation (SHOULD) that fails gives a warning, marked `!`, and passes. The exit code is 1 if a check fails. Both AcidCat cores run `conform` in their tests. In code, use `conform()` and `serve()` from `@acid-cat/cli`. This `serve()` is for tests: it listens on `127.0.0.1`, on a free port, with plain HTTP. To serve an application, use the server of its core: `serve` from `@acid-cat/core-ts/node`, or `NodeServer` from `@acid-cat/core-effect`. `createTestHost()` gives the WebMCP host of the checks.

## Implementation

The command line is an [Effect](https://effect.website) program that uses `effect/cli`. It validates catalogs with Effect Schema. It imports `schemas/catalog.schema.json` and each schema in the catalog as Effect schemas.

| File | Contents |
| --- | --- |
| `src/catalog.ts` | The catalog rules, views and bundling |
| `src/main.ts` | The commands |
| `src/conform/` | The conformance checks, and `serve`, which serves web handlers on a local port for the tests |
| `conformance/` | The conformance fixture, in Pkl and in JSON |
| `test/` | Tests. Run them with `moon run cli:test` |
| `test/fixtures/` | The catalog of the tests: a bakery, in canonical form, with capabilities and an event |
| `test/fixtures/rejected/` | Catalogs that `check` must reject, written by hand |

The canonical writer comes from [`@acid-cat/catalog`](../catalog/typescript).
