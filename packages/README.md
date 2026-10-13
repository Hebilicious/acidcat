# Packages

Each package is a Moon project with a `test` task. The TypeScript packages share a pnpm workspace. The specification in [`spec/`](../spec/README.md) does not depend on these packages.

| Package | Directory | Registry name | Use |
| --- | --- | --- | --- |
| Command line | [`cli/`](cli) | npm `@acid-cat/cli` | Check, format and view catalogs with the `acid-cat` command |
| Specification data | [`spec/`](spec) | npm `@acid-cat/spec` | The fixed details of the specification as data and pure functions, with no dependencies |
| Core for Effect | [`core-effect/`](core-effect) | npm `@acid-cat/core-effect` | Serve capabilities, written fully in Effect: capabilities are Effect programs, sessions are scopes, services are layers |
| Core for TypeScript | [`core-ts/`](core-ts) | npm `@acid-cat/core-ts` | Serve capabilities in plain TypeScript, with no Effect dependency: capabilities return promises, inputs use Standard Schema |
| Catalog library for TypeScript | [`catalog/typescript/`](catalog/typescript) | npm `@acid-cat/catalog` | Write a catalog in TypeScript |
| Catalog library for Python | [`catalog/python/`](catalog/python) | PyPI `acid-cat-catalog` | Write a catalog in Python |
| Catalog library for Go | [`catalog/go/`](catalog/go) | Go `acid-cat.dev/catalog` | Write a catalog in Go |
| Catalog library for Rust | [`catalog/rust/`](catalog/rust) | crates.io `acid-cat-catalog` | Write a catalog in Rust |
| Catalog module for Pkl | [`catalog/pkl/`](catalog/pkl) | Pkl package | Write a catalog in Pkl |

## Two cores

Each core is complete in its own style. Neither core wraps the other. Both cores serve the four protocol bindings: MCP, HTTP, CLI and WebMCP. Both cores use `@acid-cat/spec` for the fixed details, and both write the catalog of an application from its code.

| | `@acid-cat/core-effect` | `@acid-cat/core-ts` |
| --- | --- | --- |
| Capability | An Effect program | A function that returns a promise |
| Schemas | Effect Schema | Any Standard Schema library |
| Services | Layers | A context object |
| Cancellation | Fiber interruption | `AbortSignal` |
| MCP server | `effect/ai/McpServer` | Built in |
| Command line | `effect/cli` | Built in |

## Roadmap

- `acid-cat conform`: test a running provider through each of its bindings. Both cores MUST pass it.
