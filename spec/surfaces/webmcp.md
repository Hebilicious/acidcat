# WebMCP surface

A protocol surface that registers capabilities as WebMCP tools in a web page. Agents in the browser use these tools. A target with this surface usually also uses the [TypeScript surface](typescript.md).

## Host

The surface uses `document.modelContext`. If it does not exist, the surface uses `navigator.modelContext`. A host is valid only if its `registerTool` is a function.

If no host is valid, the surface does nothing and loads nothing. The page then works as it does without WebMCP.

The surface MUST NOT use the return value of `registerTool`. To remove a tool, the surface aborts the signal that it gave to `registerTool`.

## Tools

- **Names.** The `name` of a tool is the id. Its `description` is the description of the capability. Its `inputSchema` is the [bundled](../catalog.md#bundling) input schema. The page can include the schemas in its code, or load precomputed schemas when it first needs them.
- **Listing.** A capability is registered while it is available. It is removed when it becomes unavailable. The surface does one update at a time. A change during an update causes one more update. If an update fails, the tools stay as they were before the update.
- **Outcomes.** `execute` resolves with the result in its JSON form. A call failure rejects with an `Error` that has a `kind` property.
- **Cancellation.** The signal that the host gives to `execute` cancels the call. When the surface closes, it cancels all calls in progress.
- **Removal.** The surface SHOULD let the page remove all tools while the session stays open. After a removal, the surface registers no more tools. A removal does not cancel the calls through the handles of the session.

## Events

The WebMCP surface does not serve events. WebMCP has no way to send a message to an agent that the agent did not ask for. The page uses the [TypeScript surface](typescript.md) to follow events.

## Status

The surface SHOULD give a status that the page can observe:

| Phase | Meaning |
| --- | --- |
| `loading` | The surface loads the schemas |
| `reconciling` | The surface updates the tools to agree with availability |
| `ready` | The tools agree with availability |
| `failed` | Loading or updating failed. `message` tells why. `retry` tries again |
| `closing` | The surface removes its tools and waits for calls in progress |
| `disposed` | The surface has no tools and no calls in progress |
