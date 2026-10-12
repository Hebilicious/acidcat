# Divergence inventory

Two implementations of AcidCat exist. This inventory lists where they agree, where they differ, and what neither covers. Every row ends in a decision recorded in the spec, and the inventory is finished when no row is open.

## Sources

| Name | Repository | Ref | What to read |
| --- | --- | --- | --- |
| **JB** | `~/GitHub/jarettes-box` | `8e8653273eb5` (branch `bartering`, 2026-10-11) | `docs/architecture/acidcat/spec.md`, `docs/architecture/acidcat/inventory.md`, `docs/adr/0014-make-acidcat-the-sole-application-interface.md`, `packages/acidcat-kernel/src`, `packages/acidcat/src`, `packages/{webmcp-adapter,mcp,cli}`, `tests/features/acidcat` |
| **HS** | `~/GitHub/heb-stack` | `ae9c084a4c25` (`main`) | `README.md#acidcat`, `packages/acidcat-kernel/src`, `packages/acidcat/src`, `packages/{webmcp-adapter,mcp,cli,rpc}`, `features/` |

JB's application lives on `bartering`, while its `main` holds only the new specifications commit. Read it with `git show <ref>:<path>`, and do not check it out over that repository's working tree.

JB is the accepted specification of a production application. HS is a smaller derivative with later refinements. When the two differ, JB's spec text is the starting point unless HS's change is deliberate.

## Shared core

Both implementations agree on these points, which go into the spec almost unchanged:

- A capability leaf has an `id`, a `description`, an `audience`, and a lazily loaded program: input, output and error codecs, plus one computation.
- A catalog is a nested tree of leaves. Adapters walk it and hold no capability map of their own.
- `Result` is `{ ok: true, value } | { ok: false, error }`. Expected failures travel as `error`. Invalid input, cancellation and defects fail the invocation instead.
- External input is decoded with the leaf's own input schema before anything runs.
- `availability` is an observable `{ available: true } | { available: false, reason }`, and a session serves a leaf only when the leaf's audience names the session's target *and* the leaf is available.
- A leaf may expose a detached, observable `snapshot`.
- Every call accepts an `AbortSignal` that cancels only that call. The session has its own signal that cancels everything it started.
- Only the composition root depends on domain packages. Adapters depend on the root.

## Divergences

| # | Topic | JB | HS | Status |
| --- | --- | --- | --- | --- |
| D1 | Target names | `application \| cli \| mcp` | `web \| cli \| mcp \| rpc` | Closed: `web`, `cli`, `mcp`, `rpc`. See [Targets](targets.md#core-targets) |
| D2 | Target set | Closed union | Closed union | Closed: a fixed core, plus declared `prefix:name` extension targets. See [Extension targets](targets.md#extension-targets) |
| D3 | Human and agent on the page | One `application` target covers both Vue and WebMCP. Every capability reaches it | One `web` target covers both | Closed: no. Humans and in-page agents share `web`, which every capability reaches. See [The page](targets.md#the-page) |
| D4 | Namespace | The catalog's top-level key is a "domain". Ids look like `bartering.plan.generate`, but nothing states that the id must begin with the key | The top-level key is the namespace, every id must begin with it, and the tree mirrors the ids. Lint enforces only the bypass rule; the prefix is a convention | Closed: the id grammar and the namespace prefix are adopted, and the tree below the namespace is free. See [Identifiers](identifiers.md) |
| D5 | Capability kind | Deliberately absent: "no effect classification, no confirmation protocol" | The README lists `query` and `command`, but the kernel has no `kind` field | Open, awaiting the user. Proposed: an optional advisory `readOnly` flag in the manifest, mapped to MCP `readOnlyHint`, with no confirmation semantics. This reverses JB |
| D6 | Versioning | Deliberately absent: "the served bundle is the contract version" | Absent | Open, awaiting the user. Proposed: no versions per capability; the manifest carries a content `revision`; an incompatible change to a capability served to `cli`, `mcp` or `rpc` needs a new id. This partly reverses JB |
| D7 | Manifest | A generated compact JSON Schema manifest in the `acidcat-json-v1` format (string and node tables), proven to cover every leaf. JSON Schema conversion stays off the client | Adapters derive their schemas from the leaves, and WebMCP loads its metadata through `loadManifest` | Closed: one JSON manifest per target, with input, output and error schemas. The compact encoding is a transport only. See [Manifest](manifest.md) |
| D8 | Attachments | Opaque `SessionAttachmentHandle` values (1–128 characters) with metadata, plus a `SessionAttachments` service to register, resolve and release them | None | Closed: opaque, session-scoped handles marked `format: acidcat-attachment`, released by their owner. See [Attachments](attachments.md) |
| D9 | Session and identity | Inputs carry no identity. An authenticated session closes over its ports. Logout stops new calls, then settles or cancels owned work | Unauthenticated. A session signal disposes everything | Closed: open, closing, closed, and no identity in inputs. See [Sessions](sessions.md) |
| D10 | Output bounds | Bounded aggregates return whole. Growing collections need filters, limits and continuation, and truncation is never silent | `primes.history.list` caps at 20, with no general rule | Closed: every array is bounded, nothing is truncated silently, and pages SHOULD use `limit`, `cursor` and `nextCursor`. See [Collections](collections.md) |
| D11 | Long work | Calls await their final result. No polling protocol and no execution timeout | Same | Open, awaiting the user. Proposed: confirm JB. Calls await their result, and progress is left to bindings |
| D12 | Concurrency | No global queue. Each owner decides between overlap, reject, replace and cancel | The check machine replaces the call in flight, and a failed number retries | Closed: overlap, join, reject, replace and cancel, with guarantees for every caller. See [Concurrency](concurrency.md) |
| D13 | Error encoding | Tagged errors, schema per capability. Full `Exit` and `Cause` kept, defects logged without leaking internals | Same, with `InvocationInputFailure` for undecodable input | Closed: three outcomes and five invocation failure kinds. See [Invocation](invocation.md) |
| D14 | Transport limits | MCP screens origin and method, bounds bodies by the bytes that arrive, and refuses non-JSON | `readAtMost` in the kernel, and capnweb refuses batches that are not UTF-8 | Closed: the screens are core and the numbers are deployment configuration. See [Remote transports](transport.md) |
| D15 | MCP binding | `effect/ai/McpServer`, revision `2026-07-28`, stateless, `/mcp` | Same approach | Closed. See [MCP binding](bindings/mcp.md) |
| D16 | WebMCP binding | `document.modelContext`, falling back to `navigator.modelContext`. Registration follows availability, serialized, keeping the last good set on failure, with retry | Same adapter shape: `snapshot` and `retry` | Closed. See [WebMCP binding](bindings/webmcp.md) |
| D17 | Evidence | Product Promise manifests reference capability ids, with a reverse index and no orphans. A generic catalog-conformance suite | Gherkin features and adapter proofs | Closed: the kit checks manifests and the wire; product evidence stays in each application. See [Conformance](conformance.md) |
| D18 | Session services in the kernel | `SessionAuthentication` (a Discord-shaped user), `SessionResources`, `SessionNavigation` | None | Open, awaiting the user. Proposed: out of scope. Only the session lifecycle is specified ([Sessions](sessions.md)), and these services stay in JB |

## Not yet covered by either

- Versioning of the spec itself, and how a manifest declares which spec version it follows.
- Discovery: where a client finds the manifest for a target.
- Authorisation per capability beyond audience, if any.
- Idempotency of commands across retries, especially over MCP and RPC.
- Binding documents for the CLI and RPC surfaces. The two CLIs differ today: JB uses `list` and `call` with exit code 1 for every failure, and HS derives a command from each id. The two RPC APIs are specific to their applications.
