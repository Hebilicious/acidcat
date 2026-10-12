# Divergence inventory

*A historical record. The specification in [`spec/`](../spec/README.md) is the source of truth; this page shows how its first decisions were reached from Jarette's Box and heb-stack.*

Two implementations of AcidCat exist. This inventory records where they agreed, where they differed, and how each difference was decided. It is now a record: the decisions live in the spec, and [Adoption](../spec/adoption.md) says what each implementation changes.

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
| D1 | Target names | `application \| cli \| mcp` | `web \| cli \| mcp \| rpc` | Closed: target names belong to the application, declared in the catalog with their bindings. HS's `web` and JB's `application` both conform. See [Targets](../spec/catalog.md#targets) |
| D2 | Target set | Closed union | Closed union | Closed: open. The catalog declares its targets, so a misspelt audience is caught. See [Targets](../spec/catalog.md#targets) |
| D3 | Human and agent on the page | One `application` target covers both Vue and WebMCP. Every capability reaches it | One `web` target covers both | Closed: one target can use several bindings, so the page is one target served by `typescript` and `webmcp`. See [Bindings](../spec/bindings/README.md) |
| D4 | Namespace | The catalog's top-level key is a "domain". Ids look like `bartering.plan.generate`, but nothing states that the id must begin with the key | The top-level key is the namespace, every id must begin with it, and the tree mirrors the ids. Lint enforces only the bypass rule; the prefix is a convention | Closed: the id grammar, with the first segment as the namespace. Surface names derive from the id, never from a code tree. See [Ids](../spec/catalog.md#ids) |
| D5 | Capability kind | Deliberately absent: "no effect classification, no confirmation protocol" | The README lists `query` and `command`, but the kernel has no `kind` field | Closed: an optional `readOnly` hint, with no confirmation semantics. See [Capabilities](../spec/catalog.md#capabilities) |
| D6 | Versioning | Deliberately absent: "the served bundle is the contract version" | Absent | Closed: no versions on catalogs or capabilities. `acidcat` names the spec version. See [Change](../spec/catalog.md#change) |
| D7 | Manifest | A generated compact JSON Schema manifest in the `acidcat-json-v1` format (string and node tables), proven to cover every leaf. JSON Schema conversion stays off the client | Adapters derive their schemas from the leaves, and WebMCP loads its metadata through `loadManifest` | Closed: the catalog is the contract, and a target's view replaces the manifest. Compact encodings are transport. See [Catalog](../spec/catalog.md) |
| D8 | Attachments | Opaque `SessionAttachmentHandle` values (1–128 characters) with metadata, plus a `SessionAttachments` service to register, resolve and release them | None | Closed as an extension. See [Attachments](../spec/extensions/attachments.md) |
| D9 | Session and identity | Inputs carry no identity. An authenticated session closes over its ports. Logout stops new calls, then settles or cancels owned work | Unauthenticated. A session signal disposes everything | Closed: no identity in inputs, and open, closing, closed. See [Sessions](../spec/invocation.md#sessions) |
| D10 | Output bounds | Bounded aggregates return whole. Growing collections need filters, limits and continuation, and truncation is never silent | `primes.history.list` caps at 20, with no general rule | Closed: no silent truncation, with a recommended page shape. See [Pagination](../spec/extensions/pagination.md) |
| D11 | Long work | Calls await their final result. No polling protocol and no execution timeout | Same | Closed: calls await their result, and bindings and capabilities may do otherwise. See [Long work](../spec/invocation.md#long-work) |
| D12 | Concurrency | No global queue. Each owner decides between overlap, reject, replace and cancel | The check machine replaces the call in flight, and a failed number retries | Closed: the provider chooses its policy, and callers get guarantees. See [Cancellation and concurrency](../spec/invocation.md#cancellation-and-concurrency) |
| D13 | Error encoding | Tagged errors, schema per capability. Full `Exit` and `Cause` kept, defects logged without leaking internals | Same, with `InvocationInputFailure` for undecodable input | Closed: value, failure, and five kinds of call failure. See [Outcomes](../spec/invocation.md#outcomes) |
| D14 | Transport limits | MCP screens origin and method, bounds bodies by the bytes that arrive, and refuses non-JSON | `readAtMost` in the kernel, and capnweb refuses batches that are not UTF-8 | Closed: the screens are a rule for every remote binding, and the numbers are deployment configuration. See [Remote bindings](../spec/bindings/README.md#remote-bindings) |
| D15 | MCP binding | `effect/ai/McpServer`, revision `2026-07-28`, stateless, `/mcp` | Same approach | Closed. See [MCP binding](../spec/bindings/mcp.md) |
| D16 | WebMCP binding | `document.modelContext`, falling back to `navigator.modelContext`. Registration follows availability, serialized, keeping the last good set on failure, with retry | Same adapter shape: `snapshot` and `retry` | Closed. See [WebMCP binding](../spec/bindings/webmcp.md) |
| D17 | Evidence | Product Promise manifests reference capability ids, with a reverse index and no orphans. A generic catalog-conformance suite | Gherkin features and adapter proofs | Closed: the kit checks the catalog and each binding from outside. See [Conformance](../spec/conformance.md) |
| D18 | Session services in the kernel | `SessionAuthentication` (a Discord-shaped user), `SessionResources`, `SessionNavigation` | None | Closed: sessions may provide any services, and JB's fit as they are. See [Sessions](../spec/invocation.md#sessions) |

## Not yet covered by either

- Discovery: where a client finds the view of a target. (The spec version is now the catalog's `acidcat` member.)
- Authorisation per capability beyond audience, if any.
- Idempotency of commands across retries, especially over MCP and HTTP.
