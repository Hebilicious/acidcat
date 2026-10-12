# WebMCP binding

A protocol binding that registers a view's capabilities as WebMCP tools in a web page, for agents that act through the browser on the user's live session. It usually serves a target that also uses the [TypeScript binding](typescript.md). It depends on [Catalog](../catalog.md) and [Invocation](../invocation.md).

## Host

The binding uses `document.modelContext` when it exists, and otherwise the window's `navigator.modelContext`. A host qualifies only when its `registerTool` is a function. If no host qualifies, the binding installs nothing and does not fetch the view, and the page behaves exactly as it would with WebMCP.

The binding MUST NOT depend on what `registerTool` returns. It withdraws a tool by aborting the signal it passed at registration.

## Tools

- **Names.** A tool's `name` is the id, its `description` is the capability's description, and its `inputSchema` is the capability's input schema from the view, [bundled](../catalog.md#bundling). The page fetches the view, so it never has to convert schemas itself.
- **Listing.** A capability is registered while it is available and withdrawn when it is not. Reconciliation runs one pass at a time. A change that arrives during a pass leads to another pass. A pass that fails leaves the tools as they were before it began.
- **Outcomes.** `execute` resolves with the result in its JSON form. A call failure rejects with an `Error` whose `kind` property is the kind.
- **Cancellation.** The signal the host passes to `execute` cancels the call. Disposing of the binding cancels every call in flight.

The binding SHOULD expose a status the page can observe, with a `phase` (`loading`, `reconciling`, `ready`, `failed`, `closing` or `disposed`), a `message`, and a `retry` operation for the `failed` phase. Disposal withdraws every tool and waits for the calls in flight to settle.

## Rationale

*This section is not normative.*

The host order, registration through an abort signal, serial reconciliation, retry and disposal are the same in both implementations. Relying only on the abort signal allows for both hosts: Jarette's Box accepts a `registerTool` that returns a handle, while heb-stack rejects one. Keeping the last good set when a pass fails is what heb-stack does, and what Jarette's Box's own specification describes.
