# Packages

Each package is a Moon project with a `test` task. The TypeScript packages share a pnpm workspace. The specification in [`spec/`](../spec/README.md) does not depend on these packages.

| Package | Directory | Registry name | Use |
| --- | --- | --- | --- |
| Command line | [`cli/`](cli) | npm `@acid-cat/cli` | Check, format and view catalogs with the `acid-cat` command |
| Catalog library for TypeScript | [`catalog/typescript/`](catalog/typescript) | npm `@acid-cat/catalog` | Write a catalog in TypeScript |
| Catalog library for Python | [`catalog/python/`](catalog/python) | PyPI `acid-cat-catalog` | Write a catalog in Python |
| Catalog library for Go | [`catalog/go/`](catalog/go) | Go `acid-cat.dev/catalog` | Write a catalog in Go |
| Catalog library for Rust | [`catalog/rust/`](catalog/rust) | crates.io `acid-cat-catalog` | Write a catalog in Rust |
| Catalog module for Pkl | [`catalog/pkl/`](catalog/pkl) | Pkl package | Write a catalog in Pkl |

## Roadmap

| Package | Registry name | Use |
| --- | --- | --- |
| Specification data | npm `@acid-cat/spec` | The fixed details of the specification as data and pure functions, with no dependencies. Both cores use it |
| Core for Effect | npm `@acid-cat/core-effect` | Serve capabilities. Written fully in Effect: capabilities are Effect programs, sessions are scopes, services are layers |
| Core for TypeScript | npm `@acid-cat/core-ts` | Serve capabilities. Plain TypeScript with no Effect dependency: capabilities return promises, inputs use Standard Schema |
| `acid-cat conform` | npm `@acid-cat/cli` | Test a running provider through each of its bindings |

Each core is complete in its own style. Neither core wraps the other. Both cores MUST pass `acid-cat conform`.
