# TypeScript reference implementation

The runtime half of AcidCat in TypeScript: the kernel (handles, sessions, invocation, availability) and the generic bindings (WebMCP, MCP, CLI, HTTP), each matching its document in `spec/bindings/`. It is empty until the conformance kit exists.

## Starting point: heb-stack

The reference implementation starts from **heb-stack's kernel** at `ae9c084a4c25`: `packages/acidcat-kernel`, the executor in `packages/acidcat`, and `packages/{webmcp-adapter,mcp,cli}`. It does not start from Jarette's Box's kernel.

| | heb-stack | Jarette's Box |
| --- | --- | --- |
| Depends only on itself | Yes | No: `acidcat-kernel/src/manifest-schema.ts` imports from `apps/web` |
| Application services in the kernel | None | `SessionAuthentication` (a Discord user), `SessionResources`, `SessionNavigation`, market services |
| CLI | Generated from ids and input schemas, as [the CLI binding](../../spec/bindings/cli.md) says | Hand-written `list`, `call` and `solve` |
| WebMCP keeps the last good set when a pass fails | Yes | No: a failed pass can leave registrations stranded |
| Targets | `web`, `cli`, `mcp`, `rpc` | `application`, `cli`, `mcp` |
| Size | Small, written as a template for new applications | Shaped by 99 production capabilities |

Jarette's Box remains the proof that the design holds at production scale. Its catalog is the large test case for the toolchain, and its session lifecycle (`spec/invocation.md#sessions`) informs the kernel.

## Moving it here

1. Copy the kernel and the three adapters, and drop everything specific to `primes`.
2. Give call failures their `kind`; make the MCP binding return the outcome shapes in `spec/bindings/mcp.md`; give the CLI the exit codes in `spec/bindings/cli.md`; accept any return value from WebMCP's `registerTool`.
3. Add the HTTP binding.
4. Add a catalog generator for Effect definitions, the general form of [the JB exporter](../../adoption/jarettes-box/generate-acidcat-catalog-export.ts), writing canonical JSON with [`sdk/typescript`](../../sdk/typescript).
5. Pass the conformance kit. Then heb-stack, and later Jarette's Box, replace their own kernels with this one.

Libraries such as Effect and XState are implementation choices made here. The specification does not depend on them.
