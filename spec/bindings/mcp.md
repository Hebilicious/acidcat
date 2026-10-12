# MCP binding

A protocol binding that serves a view as a Model Context Protocol server over HTTP. It depends on [Catalog](../catalog.md), [Invocation](../invocation.md) and the rules for [remote bindings](README.md#remote-bindings).

## Server

The server answers one URL, which SHOULD be `/mcp` on the application's origin. It serves MCP revision `2026-07-28`, which keeps no state on the server between requests, and refuses revisions that require it. Each request runs in its own session, which closes once the response is complete.

The binding accepts requests without an `Origin` header and refuses requests with these answers:

| Refusal | HTTP status | JSON-RPC error |
| --- | --- | --- |
| Method other than `POST` | 405, with `Allow: POST` | none |
| `Origin` not allowed | 403 | none |
| Media type other than `application/json` | 415 | none |
| Body over the limit | 413 | `-32600` |
| Body not UTF-8, or not JSON | 400 | `-32700` |

Every refusal carries `Cache-Control: no-store`.

## Tools

- **Names and listing.** `tools/list` lists one tool for each capability in the view that is available. The tool's `name` is the id, its `description` is the capability's description, and its `inputSchema` is the capability's input schema, [bundled](../catalog.md#bundling).
- **Output schema.** When the capability's bundled output schema states `"type": "object"` at its top level, the tool declares it as `outputSchema`. Otherwise the tool has no `outputSchema`.
- **Hints.** `annotations.readOnlyHint` is `true` for a `readOnly` capability.
- **Cancellation.** Closing the request, or cancelling it, cancels the call. The binding need not answer a cancelled call.
- **Outcomes.**

  | Outcome | Answer |
  | --- | --- |
  | Value | A tool result whose text content is the JSON of the value. When the tool declares `outputSchema`, `structuredContent` is also the value |
  | Failure | A tool result with `isError: true`, whose text content is the JSON of `{ "ok": false, "error": <failure> }` |
  | `unknown-capability` | JSON-RPC error `-32602`, whose message names the tool |
  | Any other call failure | A tool result with `isError: true`, whose text content is the JSON of `{ "kind", "message" }` |

  A client tells a failure from a call failure by the `ok` member.

## Rationale

*This section is not normative.*

Both implementations run a stateless server on `/mcp` that serves `2026-07-28`, builds a session for each request, and names its tools by id. MCP treats an unknown tool as a protocol error. Every other problem is reported as a tool result, so that a model can see it and correct its call.
