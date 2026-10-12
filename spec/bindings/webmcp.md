# WebMCP binding

This binding serves a `web` session's capabilities as WebMCP tools in the page, for agents that act through the browser. It depends on [Targets](../targets.md), [Manifest](../manifest.md) and [Invocation](../invocation.md).

Closes divergence row D16.

## Host

The binding uses `document.modelContext` when it exists, and otherwise the window's `navigator.modelContext`. A host qualifies only when its `registerTool` is a function.

If neither host qualifies, the binding installs nothing and does not fetch the manifest. The page and its session behave exactly as they would with WebMCP.

The binding MUST NOT depend on what `registerTool` returns. It withdraws a tool by aborting the signal it passed at registration.

## Registration

The binding loads the `web` manifest. If the manifest's ids are not exactly the ids in the session's catalog, the load fails.

Every capability the session serves is registered as a tool. `name` is the id, `description` is the capability's description, and `inputSchema` comes from the manifest. Registration follows availability: a capability is registered when it becomes available, and withdrawn when it stops being available.

Reconciliation is serial. A change of availability that arrives during a pass leads to another pass after it. A pass that fails leaves the tools registered as they were before it began, and does not commit its partial work.

## Status

The binding exposes a status that can be observed and a `retry` operation. The status has a `phase` and a `message`:

| Phase | Meaning |
| --- | --- |
| `loading` | Fetching and checking the manifest |
| `reconciling` | Bringing registrations in line with availability |
| `ready` | Registrations match availability |
| `failed` | Loading or reconciling failed. `message` says why, and `retry` repeats the step that failed |
| `closing` | Disposing |
| `disposed` | Every tool is withdrawn and every call has settled |

## Execution

A tool's `execute` invokes the capability with the agent's input, under a signal that aborts when the host cancels the call or the binding is disposed.

- On a result, `execute` resolves with the result object, `{ "ok": true, "value": … }` or `{ "ok": false, "error": … }`.
- On an invocation failure, `execute` rejects with an `Error` whose `kind` property is the [kind](../invocation.md#invocation-failures). The error's `name` is `AbortError` for `cancelled` and `TypeError` for `invalid-input`.

## Disposal

Disposal withdraws every tool, waits for registrations and calls in flight to settle, and then reports `disposed`.

## Rationale

*This section is not normative.*

**Taken from both implementations.** The host order, registration through an abort signal, a manifest that must match the catalog exactly, serial reconciliation with a dirty flag, the six phases, retry, and disposal are the same in JB and HS.

**Neither host contract is assumed.** JB accepts a host whose `registerTool` returns a handle, while HS throws on anything other than `undefined`. WebMCP is still settling, so the binding relies only on the abort signal, which both hosts honour.

**The last good set, as HS does it.** HS commits a pass's registrations only after the whole pass succeeds. JB records each registration as it resolves and aborts them all if the pass fails later. Those tools then stay marked as registered, and a retry skips them. HS's behaviour is what JB's own specification describes.

**Errors carry `kind`.** Both implementations reject with a `TypeError`, an `AbortError` or a plain `Error`, which loses the difference between unavailable and internal. A `kind` property is the smallest change that keeps every kind apart.

**Changes for each implementation.**
- JB: fix the commit of a failed pass; add `kind` to rejections.
- HS: accept any return value from `registerTool`; add `kind` to rejections.
