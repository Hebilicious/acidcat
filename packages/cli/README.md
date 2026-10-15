# @acid-cat/cli

The AcidCat command line. npm package: `@acid-cat/cli`. It gives the `acid-cat` command. Use it at build time, in CI or by hand, to check catalogs and to test implementations. Do not use it in an application at run time.

```sh
acid-cat check [--strict] <catalog.json ...>  # check catalogs
acid-cat format [--write] <catalog.json ...>  # write catalogs in canonical form
acid-cat view <catalog.json> <target>         # write the view of one target
acid-cat conform --mcp <url> --http <url> --cli "<command>" --webmcp <url>  # test an implementation
```

Install it as a development dependency, and run it with `pnpm exec acid-cat …`:

```sh
pnpm add -D @acid-cat/cli
```

It needs Node.js 24 or later. `acid-cat conform --webmcp <url>` also needs [Playwright](https://playwright.dev) and Chromium.

## check

`check` tests a catalog against [`schemas/catalog.schema.json`](../../schemas/catalog.schema.json) and against the [catalog rules](../../spec/conformance.md#catalog) that the schema cannot express.

- An **error** is a broken rule. Example: an audience that names an unknown target.
- A **warning** is a broken recommendation. Examples: a file that is not in [canonical form](../../spec/catalog.md#canonical-form), or a member with no `x-` prefix.

The exit code is 0 if there are no errors. It is 1 if there are errors. With `--strict`, warnings also give the exit code 1.

## format

`format` writes a catalog in canonical form. Use it for catalogs that a catalog library did not write: Pkl output, generated files, or files that you edit by hand.

## conform

`conform` tests a running implementation of the [conformance fixture](conformance/fixture.pkl) through its bindings (see [Conformance](../../spec/conformance.md#acid-cat-conform)):

- **MCP:** the official MCP client, with revision `2026-07-28`, for tools and outcomes; raw requests for rejections.
- **HTTP** and **CLI:** each outcome, each kind of call failure, availability, and rejections. For the CLI, an interrupt (`SIGINT`) during a call gives exit code 130.
- **WebMCP:** the checks act as the WebMCP host. `--webmcp <url>` opens a page that serves the `app` target in Chromium, through [Playwright](https://playwright.dev), with a test `modelContext`. Install Playwright to use it: `pnpm add -D playwright`, then `pnpm exec playwright install chromium`. In code, `webmcp` can also be a function that installs the implementation on a host in the same process.
- **Properties:** with fast-check, through each remote binding: concurrent calls each get exactly their own outcome, and a cancellation changes only its own call.

The checks wait for states that they can observe, not for times: a check cancels a call to `fixture.hold` only after `fixture.held` lists it, or after its marker file exists. Each check has one deadline, 30 seconds by default (`--guard <ms>`, or `guard` in code). A check that reaches it fails with "did not settle", its requests and calls are cancelled, and the checks release each call that holds, so that the run always ends. The guard never makes a check pass.

The exit code is 1 if a check fails. Both AcidCat cores run `conform` in their tests. In code, use `conform()` and `serve()` from `@acid-cat/cli`. `createTestHost()` gives the WebMCP host of the checks.

## Implementation

The command line is an [Effect](https://effect.website) program that uses `effect/cli`. It validates catalogs with Effect Schema. It imports `schemas/catalog.schema.json` and each schema in the catalog as Effect schemas.

| File | Contents |
| --- | --- |
| `src/catalog.ts` | The catalog rules, views and bundling |
| `src/main.ts` | The commands |
| `src/conform/` | The conformance checks, and `serve`, which serves web handlers on a local port |
| `conformance/` | The conformance fixture, in Pkl and in JSON |
| `test/` | Tests. Run them with `moon run cli:test` |

The canonical writer comes from [`@acid-cat/catalog`](../catalog/typescript).
