# MCP binding

A protocol binding that serves a view as a Model Context Protocol server through HTTP. It follows the rules for [remote bindings](README.md#remote-bindings).

## Server

- The server uses one URL. It SHOULD be `/mcp` on the origin of the application.
- The server uses MCP revision `2026-07-28`. This revision keeps no state on the server between requests. The server rejects revisions that keep state.
- The server answers `server/discover`, `tools/list` and `tools/call`.
- **Instructions.** The `instructions` of `server/discover` tell a model how to use the server as a whole. The application MAY give its own instructions. If it gives none, the instructions are the `description` of the catalog. If the catalog has no `description` either, the result has no `instructions`.
- Each request has its own session. The session closes when the response is complete.
- The server accepts requests that have no `Origin` header.

The server rejects requests as follows. Each rejection has the header `Cache-Control: no-store`.

| Problem | HTTP status | JSON-RPC error |
| --- | --- | --- |
| The method is not `POST` | 405, with `Allow: POST` | None |
| The `Origin` is not allowed | 403 | None |
| The media type is not `application/json` | 415 | None |
| The body is too long | 413 | `-32600` |
| The body is not UTF-8, or not JSON | 400 | `-32700` |

## Tools

- **Names and listing.** `tools/list` gives one tool for each available capability in the view. An unavailable capability is not listed. A call to it gets the same answer as a call to an unknown tool. The `name` of the tool is the id. Its `description` is the description of the capability. Its `inputSchema` is the [bundled](../catalog.md#bundling) input schema.
- **Output schema.** If the bundled output schema has `"type": "object"`, the tool gives it as `outputSchema`. If not, the tool has no `outputSchema`.
- **Hints.** For a `readOnly` capability, `annotations.readOnlyHint` is `true`.
- **Cancellation.** When the client closes or cancels the request, the call is cancelled. The server does not have to answer a cancelled call.
- **Outcomes.**

  | Outcome | Answer |
  | --- | --- |
  | Value | A tool result. Its text content is the JSON of the value. If the tool has `outputSchema`, `structuredContent` is the value |
  | Failure | A tool result with `isError: true`. Its text content is the JSON of `{ "ok": false, "error": <failure> }` |
  | `unknown-capability` | The JSON-RPC error `-32602`. The message gives the name of the tool |
  | Other call failures | A tool result with `isError: true`. Its text content is the JSON of `{ "kind", "message" }` |

  The `ok` member identifies a failure. A call failure has no `ok` member.

## Design notes

*This section is not normative.*

MCP gives an unknown tool as a protocol error. All other problems come back as tool results, so that a model can see them and correct its call.
