# Packages

What this repository builds and distributes, all under the name `acid-cat`. Every package is a Moon project, and the TypeScript packages share a pnpm workspace. The specification itself lives in [`spec/`](../spec/README.md) and does not depend on any of them.

| Package | Directory | Published as | Role |
| --- | --- | --- | --- |
| Command line | [`cli/`](cli) | npm `@acid-cat/cli` (the `acid-cat` command) | Check, format and view catalogs; later, run the conformance tests |
| Catalog library, TypeScript | [`catalog/typescript/`](catalog/typescript) | npm `@acid-cat/catalog` | Write a catalog |
| Catalog library, Python | [`catalog/python/`](catalog/python) | PyPI `acid-cat-catalog` | Write a catalog |
| Catalog library, Go | [`catalog/go/`](catalog/go) | Go module `acid-cat.dev/catalog` | Write a catalog |
| Catalog library, Rust | [`catalog/rust/`](catalog/rust) | crates.io `acid-cat-catalog` | Write a catalog |
| Catalog module, Pkl | [`catalog/pkl/`](catalog/pkl) | Pkl package | Write a catalog |
| Core | `core/`, planned | npm `@acid-cat/core` | The reference implementation: serve a catalog's capabilities, with no dependency on Effect |
| Effect | `effect/`, planned | npm `@acid-cat/effect` | Define capabilities with Effect, and run them on the core |

Nothing is published yet. Every package is marked private until the user decides to release.

## Several catalog libraries, one core

**Catalog libraries in several languages.** Writing a catalog is how every project starts, in whatever language it uses. A catalog library is small, has no runtime behaviour, and is held to identical output by two shared fixtures. Supporting several of them costs little and makes adoption easy.

**One core, in TypeScript.** The core serves capabilities: handles, sessions, invocation, availability, and the WebMCP, MCP, CLI and HTTP bindings. That is real behaviour, and maintaining it in several languages would multiply the work and the bugs. AcidCat ships one, in TypeScript, because the first two implementations (Jarette's Box and heb-stack) are TypeScript. Other languages implement the specification themselves, and `acid-cat conform` proves that they do.

## The command line

`@acid-cat/cli` is the only command-line tool, so there is one thing to install:

| Command | Does |
| --- | --- |
| `acid-cat check <catalog.json …>` | Validate catalogs, including canonical form |
| `acid-cat format [--write] <catalog.json …>` | Put a catalog in canonical form |
| `acid-cat view <catalog.json> <target>` | Print the view of one target |
| `acid-cat conform …` (planned) | Run the conformance tests against a running implementation: an MCP endpoint, an HTTP API, a CLI, or a page with WebMCP. They use a fixture catalog that the implementation serves, and property-based tests for the guarantees in [Invocation](../spec/invocation.md) |

## Core and Effect

One implementation, with two ways to write capabilities for it:

- **`@acid-cat/core`** is plain TypeScript. A capability's `run` takes its input and an `AbortSignal` and returns a promise of its result. Inputs are validated with any library that implements [Standard Schema](https://standardschema.dev), such as Zod, Valibot or ArkType. The bindings are entry points of the same package: `@acid-cat/core/webmcp`, `/mcp`, `/cli` and `/http`. Applications that do not use Effect never install it.
- **`@acid-cat/effect`** depends on the core and on Effect. It defines capabilities with Effect Schema and Effect programs, runs them in an Effect runtime with the application's layers, and hands them to the core. Jarette's Box and heb-stack use this one.

Two separate packages keep Effect out of the core's dependencies without optional peer dependencies. And because there is one core, there is one implementation for `acid-cat conform` to test, rather than two that drift apart.

### Where the core comes from

The core follows heb-stack's design at `ae9c084a4c25` (`packages/acidcat-kernel`, the executor in `packages/acidcat`, and `packages/{webmcp-adapter,mcp,cli}`). Its Effect-specific parts move into `@acid-cat/effect`.

| | heb-stack | Jarette's Box |
| --- | --- | --- |
| Depends only on itself | Yes | No: `acidcat-kernel/src/manifest-schema.ts` imports from `apps/web` |
| Application services in the kernel | None | A Discord session user, navigation, resources, market services |
| CLI | Generated from ids and input schemas, as [the CLI binding](../spec/bindings/cli.md) says | Hand-written `list`, `call` and `solve` |
| WebMCP keeps the last good set when a pass fails | Yes | No: a failed pass can leave registrations stranded |

Steps:
1. Write the core's kernel in plain TypeScript, following heb-stack's handles, sessions and executor.
2. Write the bindings: give call failures their `kind`, follow the outcome shapes of [the MCP binding](../spec/bindings/mcp.md) and the exit codes of [the CLI binding](../spec/bindings/cli.md), and add [the HTTP binding](../spec/bindings/http.md).
3. Move heb-stack's Effect definitions and the catalog generator into `@acid-cat/effect`. The generator is the general form of [the JB exporter](../adoption/jarettes-box/generate-acid-cat-catalog-export.ts).
4. Pass `acid-cat conform`. heb-stack switches first, then Jarette's Box.
