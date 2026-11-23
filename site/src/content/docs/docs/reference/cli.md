---
title: The acid-cat command
description: Reference for the acid-cat command line, from @acid-cat/cli. It checks, formats and views catalogs, and tests implementations.
sidebar:
  order: 31
  label: acid-cat command
---

The `acid-cat` command comes from the npm package `@acid-cat/cli`. It checks catalogs and tests implementations. Run it at build time, in CI or by hand. Do not use it in an application at run time.

```sh
acid-cat check [--strict] [--output json] <catalog.json ...>
acid-cat format [--write] <catalog.json ...>
acid-cat view <catalog.json> <target>
acid-cat conform --mcp <url> [--mcp-handshake] --mcp-stdio "<command>" --http <url> --cli "<command>" --webmcp <url> \
  [--deadline <ms>] [--max-bytes <n>] [--output json] \
  [--poll-buffer <n>] [--poll-lease-mcp <url> --poll-lease-ms <ms>] \
  [--webhook-principal <name> --webhook-cert <file> --webhook-key <file>] \
  [--webhook-other-principal <name>] [--webhook-min-ttl-ms <ms>] [--webhook-max-ttl-ms <ms>] [--webhook-max-subscriptions <n>]
```

## Install

```sh
pnpm add -D @acid-cat/cli
pnpm exec acid-cat check aircon.acidcat.json
```

- It needs Node.js 24 or later.
- `acid-cat conform --webmcp <url>` also needs [Playwright](https://playwright.dev) and Chromium.
- `acid-cat` ignores a first argument `--`, which package runners such as `pnpm` and `npx` pass to it. `pnpm acid-cat -- check` is `acid-cat check`.

## check

Tests catalogs against the JSON Schema of catalogs, and against the [catalog rules](/spec/conformance/#catalog) that the schema cannot express. It also checks each alias in `options.cli` against the [alias rules](/spec/bindings/cli/#aliases).

```sh
acid-cat check --strict aircon.acidcat.json
```

It reports two levels:

- An **error** is a broken rule. Examples: an audience that names an unknown target, an event payload that is not an object, or an id that is both a capability and an event.
- A **warning** is a broken recommendation. Examples: a file that is not in [canonical form](/spec/catalog/#canonical-form), or a member with no `x-` prefix.

| Flag | What it does |
| --- | --- |
| `--strict` | Warnings also give the exit code 1 |
| `--output json` | Write the result as JSON. See [Output](#output) |

The exit code is 1 with errors, and 0 otherwise.

## format

Writes catalogs in [canonical form](/spec/catalog/#canonical-form). Use it for catalogs that no catalog library wrote: Pkl output, generated files, or files that you edit by hand.

```sh
acid-cat format --write greenhouse.acidcat.json
```

| Flag | What it does |
| --- | --- |
| `--write` | Change the files in place |

## view

Writes the [view](/spec/catalog/#views) of one target: the capabilities, events and types that the target can use.

```sh
acid-cat view aircon.acidcat.json mcp
```

## conform

Tests a running implementation of the [conformance fixture](/spec/conformance/#the-conformance-fixture) through its bindings. Give one or more bindings. Each AcidCat core runs it in its tests. [Test an implementation with acid-cat conform](/docs/guides/test-with-conform/) shows how to use it.

| Flag | In code | What it does |
| --- | --- | --- |
| `--mcp <url>` | `mcp` | Test the MCP binding through HTTP |
| `--mcp-handshake` | `mcpHandshake: true` | Also test the `initialize` handshake of earlier revisions through HTTP |
| `--mcp-stdio "<command>"` | `mcpStdio` | Test the MCP binding through stdio. Each check starts the server as a process |
| `--http <url>` | `http` | Test the HTTP binding. The URL is the base URL, before `/capabilities` |
| `--cli "<command>"` | `cli` | Test the CLI binding |
| `--webmcp <url>` | `webmcp` | Test the WebMCP binding on a page that serves the `app` target. In code, `webmcp` can also be a function that installs the implementation on a host in the same process |
| `--deadline <ms>` | `deadline` | The deadline of each check. The default is 30 000 |
| `--max-bytes <n>` | `maximumBytes` | The body limit of the remote bindings, in bytes. The default is 1 048 576 |
| `--poll-buffer <n>` | `poll.bufferLimit` | The poll buffer size of the deployment, from 1 to 97 |
| `--poll-lease-mcp <url>`, `--poll-lease-ms <ms>` | `pollLease: { mcp, leaseMs }` | An MCP server through HTTP with a poll lease time shorter than the deadline, and that lease time. Give both together |
| `--webhook-principal <name>`, `--webhook-cert <file>`, `--webhook-key <file>` | `webhook: { principal, cert, key }`, with the PEM text | Test webhook delivery. Give all three together |
| `--webhook-min-ttl-ms <ms>`, `--webhook-max-ttl-ms <ms>` | `webhook.minTtlMs`, `webhook.maxTtlMs` | The webhook lifetimes of the deployment. The defaults are 60 000 and 3 600 000 |
| `--webhook-max-subscriptions <n>` | `webhook.maxSubscriptions` | The limit of webhook subscriptions for one principal |
| `--webhook-other-principal <name>` | `webhook.otherPrincipal` | A second principal, for `Authorization: Bearer <name>` |
| `--output json` | | Write the result as JSON. See [Output](#output) |

A failed check of a SHOULD rule gives a warning, marked `!`, and passes. The exit code is 1 if a check fails.

`conform()`, `serve()` and `createTestHost()` also come from `@acid-cat/cli`, for use in code. This `serve()` is for tests only: it listens on `127.0.0.1`, on a free port, with plain HTTP.

## Output

`check` and `conform` take `--output human` (the default) or `--output json`. Human output is text for a person. JSON output is one JSON document on standard output, for a script or an agent, and nothing on standard error. The exit code is the same in both modes.

`check` writes:

```json
{ "conforms": false, "catalogs": [{ "file": "aircon.acidcat.json", "errors": ["…"], "warnings": [] }] }
```

`conforms` is `false` when the exit code is 1. A file that cannot be read, or that is not JSON, is a catalog with one error.

`conform` writes:

```json
{ "passed": 0, "failed": 0, "warnings": 0, "checks": [{ "binding": "…", "name": "…", "rule": "…", "passed": true }] }
```

Each check can also have `warning` and `detail`. A check with a warning has `"passed": true` and `"warning": true`, and counts in both `passed` and `warnings`.

You get the JSON document only when the options are correct. With incorrect options, the exit code is 1, and standard output can hold the help text.

## Read more

- [Conformance](/docs/concepts/conformance/)
- [Conformance](/spec/conformance/) in the specification
- [`@acid-cat/cli` README](https://github.com/Hebilicious/acidcat/blob/main/packages/cli/README.md)
