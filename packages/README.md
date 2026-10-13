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
| Core for Effect | `core-effect/`, planned | npm `@acid-cat/core-effect` | Serve a catalog's capabilities, written entirely in Effect |
| Core for TypeScript | `core-ts/`, planned | npm `@acid-cat/core-ts` | Serve a catalog's capabilities in plain TypeScript, with no Effect in its dependencies |
| Spec details | `spec/`, planned | npm `@acid-cat/spec` | The specification's fixed details as data and pure functions, with no dependencies, shared by both cores |

Nothing is published yet. Every package is marked private until the user decides to release.

## Several catalog libraries, two cores

**Catalog libraries in several languages.** Writing a catalog is how every project starts, in whatever language it uses. A catalog library is small, has no runtime behaviour, and is held to identical output by two shared fixtures. Supporting several of them costs little and makes adoption easy.

**Two cores, both TypeScript.** A core serves capabilities: handles, sessions, invocation, availability, and the WebMCP, MCP, CLI and HTTP bindings. TypeScript users split into two groups that will not share one. Effect users want their whole program in Effect. Everyone else wants no Effect in their dependencies. A core that compromises for either group gets rewritten by that group, so AcidCat ships one core for each (see [Two cores](#two-cores)). Other languages implement the specification themselves, and `acid-cat conform` proves that they do.

## The command line

`@acid-cat/cli` is the only command-line tool, so there is one thing to install:

| Command | Does |
| --- | --- |
| `acid-cat check <catalog.json …>` | Validate catalogs, including canonical form |
| `acid-cat format [--write] <catalog.json …>` | Put a catalog in canonical form |
| `acid-cat view <catalog.json> <target>` | Print the view of one target |
| `acid-cat conform …` (planned) | Run the conformance tests against a running implementation: an MCP endpoint, an HTTP API, a CLI, or a page with WebMCP. They use a fixture catalog that the implementation serves, and property-based tests for the guarantees in [Invocation](../spec/invocation.md) |

## Two cores

Each core is complete in its own style. Neither wraps the other.

- **`@acid-cat/core-effect`** is written entirely in Effect. A capability is an Effect program with Effect Schema codecs. Sessions are scopes. The application's services are layers. The bindings are Effect services: an MCP server on `effect/ai`, the WebMCP adapter, a CLI on `effect/cli`, and an HTTP API. An Effect application never leaves Effect. Jarette's Box and heb-stack use this core.
- **`@acid-cat/core-ts`** is plain TypeScript, and none of its dependencies is Effect. A capability's `run` takes its input and an `AbortSignal` and returns a promise of its result. Inputs are validated with any library that implements [Standard Schema](https://standardschema.dev), such as Zod, Valibot or ArkType. The bindings are entry points of the same package: `@acid-cat/core-ts/webmcp`, `/mcp`, `/cli` and `/http`.

Two implementations could drift apart. Two things keep them together:

- **`acid-cat conform`.** Both cores must pass the same conformance tests before either is released.
- **`@acid-cat/spec`.** The details the specification fixes are written once, as plain data and pure functions with no dependencies: outcome and call-failure types; MCP result shapes; CLI exit codes; HTTP statuses; how an id becomes a tool name, a command path or a GraphQL field. Both cores import them instead of restating them. A package with no dependencies costs an Effect application nothing.

### Where the cores come from

`@acid-cat/core-effect` starts from heb-stack's kernel at `ae9c084a4c25`: `packages/acidcat-kernel`, the executor in `packages/acidcat`, and `packages/{webmcp-adapter,mcp,cli}`. It does not start from Jarette's Box's kernel:

| | heb-stack | Jarette's Box |
| --- | --- | --- |
| Depends only on itself | Yes | No: `acidcat-kernel/src/manifest-schema.ts` imports from `apps/web` |
| Application services in the kernel | None | A Discord session user, navigation, resources, market services |
| CLI | Generated from ids and input schemas, as [the CLI binding](../spec/bindings/cli.md) says | Hand-written `list`, `call` and `solve` |
| WebMCP keeps the last good set when a pass fails | Yes | No: a failed pass can leave registrations stranded |

Steps:
1. Write `@acid-cat/spec` from the binding documents.
2. Build `@acid-cat/core-effect` from heb-stack's kernel and adapters, without the `primes` domain. Give call failures their `kind`, take the binding details from `@acid-cat/spec`, add the HTTP binding, and add a catalog generator for Effect definitions, the general form of [the JB exporter](../adoption/jarettes-box/generate-acid-cat-catalog-export.ts).
3. Pass `acid-cat conform`. heb-stack switches first, then Jarette's Box.
4. Build `@acid-cat/core-ts` on the same design, without Effect, and pass the same tests.
