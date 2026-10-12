# Divergence inventory

Two implementations of AcidCat exist. This inventory lists where they agree, where they differ, and what neither covers. Every row ends in a decision recorded in the spec, and the inventory is finished when no row is open.

## Sources

| Name | Repository | Ref | What to read |
| --- | --- | --- | --- |
| **JB** | `~/GitHub/jarettes-box` | `04c453459879` (branch `fix/iliya-map-marker-zoom`, 2026-10-09) | `docs/architecture/acidcat/spec.md`, `docs/architecture/acidcat/inventory.md`, `docs/adr/0014-make-acidcat-the-sole-application-interface.md`, `packages/acidcat-kernel/src`, `packages/acidcat/src`, `packages/{webmcp-adapter,mcp,cli}`, `tests/features/acidcat` |
| **HS** | `~/GitHub/heb-stack` | `ae9c084a4c25` (`main`) | `README.md#acidcat`, `packages/acidcat-kernel/src`, `packages/acidcat/src`, `packages/{webmcp-adapter,mcp,cli,rpc}`, `features/` |

JB's `main` was reset to a fresh specifications commit, so its AcidCat code is reachable only from branches. Read it with `git show <ref>:<path>`, and do not check it out over that repository's working tree.

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
| D1 | Target names | `application \| cli \| mcp` | `web \| cli \| mcp \| rpc` | Open. Naming, plus whether `rpc` is a target |
| D2 | Target set | Closed union | Closed union | Open. The spec needs an extensible registry, or a fixed core with extension targets |
| D3 | Human and agent on the page | One `application` target covers both Vue and WebMCP. Every capability reaches it | One `web` target covers both | Open. Decide whether in-page agents get their own audience |
| D4 | Namespace | The catalog's top-level key is a "domain". Ids look like `bartering.plan.generate`, but nothing states that the id must begin with the key | The top-level key is the namespace, every id must begin with it, and the tree mirrors the ids. Lint enforces it | Open. HS's rule is the candidate |
| D5 | Capability kind | Deliberately absent: "no effect classification, no confirmation protocol" | The README lists `query` and `command`, but the kernel has no `kind` field | Open. Either specify `kind` or remove it from HS's README |
| D6 | Versioning | Deliberately absent: "the served bundle is the contract version" | Absent | Open. This holds within one deployed bundle, but not for MCP, the CLI or RPC clients of another build |
| D7 | Manifest | A generated compact JSON Schema manifest in the `acidcat-json-v1` format (string and node tables), proven to cover every leaf. JSON Schema conversion stays off the client | Adapters derive their schemas from the leaves, and WebMCP loads its metadata through `loadManifest` | Open. Specify the manifest document. Decide whether the compact encoding is normative or only a transport |
| D8 | Attachments | Opaque `SessionAttachmentHandle` values (1–128 characters) with metadata, plus a `SessionAttachments` service to register, resolve and release them | None | Open. Likely normative, since binary input is common |
| D9 | Session and identity | Inputs carry no identity. An authenticated session closes over its ports. Logout stops new calls, then settles or cancels owned work | Unauthenticated. A session signal disposes everything | Open. Specify the session lifecycle. Identity stays out of inputs |
| D10 | Output bounds | Bounded aggregates return whole. Growing collections need filters, limits and continuation, and truncation is never silent | `primes.history.list` caps at 20, with no general rule | Open. Adopt JB's rule and specify how continuation is shaped |
| D11 | Long work | Calls await their final result. No polling protocol and no execution timeout | Same | Open. Confirm, or specify progress notification |
| D12 | Concurrency | No global queue. Each owner decides between overlap, reject, replace and cancel | The check machine replaces the call in flight, and a failed number retries | Open. Specify which policies an owner may choose and what a caller observes under each. The Lean model's main subject |
| D13 | Error encoding | Tagged errors, schema per capability. Full `Exit` and `Cause` kept, defects logged without leaking internals | Same, with `InvocationInputFailure` for undecodable input | Open. Specify on the wire how invalid input, cancellation and defects differ |
| D14 | Transport limits | MCP screens origin and method, bounds bodies by the bytes that arrive, and refuses non-JSON | `readAtMost` in the kernel, and capnweb refuses batches that are not UTF-8 | Open. Decide whether this is spec or a transport binding |
| D15 | MCP binding | `effect/ai/McpServer`, revision `2026-07-28`, stateless, `/mcp` | Same approach | Open. Write it as a binding document |
| D16 | WebMCP binding | `document.modelContext`, falling back to `navigator.modelContext`. Registration follows availability, serialized, keeping the last good set on failure, with retry | Same adapter shape: `snapshot` and `retry` | Open. Write it as a binding document |
| D17 | Evidence | Product Promise manifests reference capability ids, with a reverse index and no orphans. A generic catalog-conformance suite | Gherkin features and adapter proofs | Open. Decide what the conformance kit checks and what stays in each application |
| D18 | Session services in the kernel | `SessionAuthentication` (a Discord-shaped user), `SessionResources`, `SessionNavigation` | None | Probably out of scope: specific to the application. Confirm |

## Not yet covered by either

- Versioning of the spec itself, and how a manifest declares which spec version it follows.
- Discovery: where a client finds the manifest for a target.
- Authorisation per capability beyond audience, if any.
- Idempotency of commands across retries, especially over MCP and RPC.
