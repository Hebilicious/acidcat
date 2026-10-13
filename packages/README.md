# Packages

What this repository builds and distributes. Every package is a Moon project, and the TypeScript packages share a pnpm workspace. The specification itself lives in [`spec/`](../spec/README.md) and does not depend on any of them.

| Package | Directory | Published as | Role |
| --- | --- | --- | --- |
| Toolchain | [`toolchain/`](toolchain) | npm `acidcat` (the `acidcat` command) | Check, format and view catalogs at build time |
| Catalog library, TypeScript | [`catalog/typescript/`](catalog/typescript) | npm `@acidcat/catalog` | Write a catalog |
| Catalog library, Python | [`catalog/python/`](catalog/python) | PyPI `acidcat-catalog` | Write a catalog |
| Catalog library, Go | [`catalog/go/`](catalog/go) | Go module `acidcat.dev/catalog` | Write a catalog |
| Catalog library, Rust | [`catalog/rust/`](catalog/rust) | crates.io `acidcat-catalog` | Write a catalog |
| Catalog module, Pkl | [`catalog/pkl/`](catalog/pkl) | Pkl package | Write a catalog |
| Runtime | `runtime/`, planned | npm `@acidcat/runtime` | Serve a catalog's capabilities: the kernel and the bindings |
| Conformance kit | `conformance/`, planned | npm `@acidcat/conformance` | Judge any implementation from outside |

Nothing is published yet. Every package is marked private until the user decides to release.

## Several catalog libraries, one runtime

**Catalog libraries in several languages.** Writing a catalog is how every project starts, in whatever language it uses. A catalog library is small, has no runtime behaviour, and is held to identical output by two shared fixtures. Supporting several of them costs little and makes adoption easy.

**One runtime, in TypeScript.** A runtime serves capabilities: handles, sessions, invocation, availability, and the WebMCP, MCP, CLI and HTTP bindings. That is real behaviour, and maintaining it in several languages would multiply the work and the bugs. AcidCat ships one runtime, in TypeScript, because the first two implementations (Jarette's Box and heb-stack) are TypeScript. Other languages implement the specification themselves, and the conformance kit proves that they do.

## The runtime starts from heb-stack

`@acidcat/runtime` starts from heb-stack's kernel at `ae9c084a4c25`: `packages/acidcat-kernel`, the executor in `packages/acidcat`, and `packages/{webmcp-adapter,mcp,cli}`.

| | heb-stack | Jarette's Box |
| --- | --- | --- |
| Depends only on itself | Yes | No: `acidcat-kernel/src/manifest-schema.ts` imports from `apps/web` |
| Application services in the kernel | None | A Discord session user, navigation, resources, market services |
| CLI | Generated from ids and input schemas, as [the CLI binding](../spec/bindings/cli.md) says | Hand-written `list`, `call` and `solve` |
| WebMCP keeps the last good set when a pass fails | Yes | No: a failed pass can leave registrations stranded |

Steps: copy the kernel and the three adapters without the `primes` domain; give call failures their `kind`; follow the outcome shapes of [the MCP binding](../spec/bindings/mcp.md) and the exit codes of [the CLI binding](../spec/bindings/cli.md); add [the HTTP binding](../spec/bindings/http.md); add a catalog generator for Effect definitions, the general form of [the JB exporter](../adoption/jarettes-box/generate-acidcat-catalog-export.ts); then pass the conformance kit. heb-stack switches to it first, then Jarette's Box.

Effect and XState are choices made inside the runtime. The specification does not depend on them.
