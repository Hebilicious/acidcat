# WebMCP binding

A protocol binding that registers capabilities as WebMCP tools in a web page. Agents in the browser use these tools. A target with this binding usually also uses the [TypeScript binding](typescript.md).

## Host

The binding uses `document.modelContext`. If it does not exist, the binding uses `navigator.modelContext`. A host is valid only if its `registerTool` is a function.

If no host is valid, the binding does nothing and loads nothing. The page then works as it does without WebMCP.

The binding MUST NOT use the return value of `registerTool`. To remove a tool, the binding aborts the signal that it gave to `registerTool`.

## Tools

- **Names.** The `name` of a tool is the id. Its `description` is the description of the capability. Its `inputSchema` is the [bundled](../catalog.md#bundling) input schema. The page can include the schemas in its code, or load precomputed schemas when it first needs them.
- **Listing.** A capability is registered while it is available. It is removed when it becomes unavailable. The binding does one update at a time. A change during an update causes one more update. If an update fails, the tools stay as they were before the update.
- **Outcomes.** `execute` resolves with the result in its JSON form. A call failure rejects with an `Error` that has a `kind` property.
- **Cancellation.** The signal that the host gives to `execute` cancels the call. When the binding closes, it cancels all calls in progress.

## Status

The binding SHOULD give a status that the page can observe:

| Phase | Meaning |
| --- | --- |
| `loading` | The binding loads the schemas |
| `reconciling` | The binding updates the tools to agree with availability |
| `ready` | The tools agree with availability |
| `failed` | Loading or updating failed. `message` tells why. `retry` tries again |
| `closing` | The binding removes its tools and waits for calls in progress |
| `disposed` | The binding has no tools and no calls in progress |
