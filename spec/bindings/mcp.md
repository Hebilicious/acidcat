# MCP binding

A protocol binding that serves a view as a Model Context Protocol (MCP) server. The binding has two transports:

- [HTTP](#http): a server on the network. It follows the rules for [remote bindings](README.md#remote-bindings).
- [Stdio](#stdio): a local process. The client starts the server as a process, and they exchange messages through the standard input and the standard output of that process.

A server serves one transport or both. The rules for the [server](#server) and the [tools](#tools) apply to both transports.

## Server

- The server answers `tools/list` and `tools/call`. Each transport tells how a client opens the session, and the other methods that the server answers.
- **Instructions.** The `instructions` of the server tell a model how to use the server as a whole. The server gives them in the result of `server/discover`, and in the result of `initialize` when the transport has that handshake. The application MAY give its own instructions. If it gives none, the instructions are the `description` of the catalog. If the catalog has no `description` either, the result has no `instructions`.

## Tools

- **Names and listing.** `tools/list` gives one tool for each available capability in the view. An unavailable capability is not listed. A call to it gets the same answer as a call to an unknown tool. The `name` of the tool is the id. Its `description` is the description of the capability. Its `inputSchema` is the [bundled](../catalog.md#bundling) input schema.
- **Output schema.** If the bundled output schema has `"type": "object"`, the tool gives it as `outputSchema`. If not, the tool has no `outputSchema`.
- **Hints.** For a `readOnly` capability, `annotations.readOnlyHint` is `true`.
- **Cancellation.** When the client cancels the request of a call, the call is cancelled. Each transport tells how the client cancels a request. The server does not have to answer a cancelled call.
- **Outcomes.**

  | Outcome | Answer |
  | --- | --- |
  | Value | A tool result. Its text content is the JSON of the value. If the tool has `outputSchema`, `structuredContent` is the value |
  | Failure | A tool result with `isError: true`. Its text content is the JSON of `{ "ok": false, "error": <failure> }` |
  | `unknown-capability` | The JSON-RPC error `-32602`. The message gives the name of the tool |
  | Other call failures | A tool result with `isError: true`. Its text content is the JSON of `{ "kind", "message" }` |

  The `ok` member identifies a failure. A call failure has no `ok` member.

## HTTP

- The server uses one URL. It SHOULD be `/mcp` on the origin of the application.
- The server keeps no state between requests. It serves MCP revisions as [Revisions through HTTP](#revisions-through-http) tells.
- Each request has its own session. The session closes when the response is complete.
- When the client closes the request of a call, the call is cancelled.
- The server accepts requests that have no `Origin` header.

The server rejects requests as follows. Each rejection has the header `Cache-Control: no-store`.

| Problem | HTTP status | JSON-RPC error |
| --- | --- | --- |
| The method is not `POST` | 405, with `Allow: POST` | None |
| The `Origin` is not allowed | 403 | None |
| The media type is not `application/json` | 415 | None |
| The body is too long | 413 | `-32600` |
| The body is not UTF-8, or not JSON | 400 | `-32700` |

### Revisions through HTTP

The server MUST serve MCP revision `2026-07-28`, and the `initialize` handshake of revision `2025-11-25`. It MAY serve the `initialize` handshake of earlier revisions. The `MCP-Protocol-Version` header of a request gives its revision:

| Header | Revision of the request |
| --- | --- |
| `2026-07-28` | `2026-07-28` |
| A revision with a handshake that the server serves | That revision |
| No header | A revision with a handshake, unless `params._meta["io.modelcontextprotocol/protocolVersion"]` is `2026-07-28`. Then the server rejects the request with status 400 and the JSON-RPC error `-32020` |
| Another value | None. The server rejects the request with status 400 and the JSON-RPC error `-32022`. The `data.supported` member of the error lists the revisions that the server serves |

A request of revision `2026-07-28` follows that revision. The server answers `server/discover`, `tools/list` and `tools/call`.

The server keeps no state for a revision with a handshake either:

- The server answers `initialize`, `ping`, `tools/list` and `tools/call`.
- `initialize` gives the revision of the client if the server serves it. If not, it gives the latest revision that the server serves with that handshake. Its capabilities are `"tools": { "listChanged": false }`.
- The server gives no `Mcp-Session-Id` header.
- The server answers a notification with status 202 and no body.
- A JSON-RPC error has the status 200.
- A result has none of the members that only revision `2026-07-28` has: `_meta`, `resultType`, `ttlMs` and `cacheScope`.

## Stdio

The client starts the server as a process. The client writes JSON-RPC messages to the standard input of the process, and the server writes JSON-RPC messages to its standard output.

- **Messages.** Each message is one line of UTF-8 JSON, which ends with a newline. A message contains no newline. Standard output MUST contain only these messages. The server writes its logs to standard error.
- **Lines that are not messages.** The server ignores an empty line. It answers a line that is not JSON with the JSON-RPC error `-32700` and `"id": null`. The session stays open.
- **One session.** The process is one session. The session opens when the process starts. When standard input ends, the session closes: the server cancels the calls in progress, and the process exits. The server does not have to answer the requests that it did not answer before.
- **Revisions.** The server MUST serve MCP revision `2026-07-28`, and the `initialize` handshake of revision `2025-11-25`. It MAY serve the `initialize` handshake of earlier revisions. A request of revision `2026-07-28` gives its revision in `params._meta["io.modelcontextprotocol/protocolVersion"]`. A client of an earlier revision opens the session with `initialize`.
- **Version negotiation.** `server/discover` gives each revision that the server serves in `supportedVersions`. `initialize` gives the revision of the client if the server serves it. If not, it gives the latest revision that the server serves with that handshake.
- **Methods.** The server serves `server/discover`, `subscriptions/listen`, `initialize`, `ping`, `tools/list` and `tools/call`.
- **Changes of the tools.** The server declares `"tools": { "listChanged": true }` in its capabilities. When the set of available capabilities changes, the server MUST send `notifications/tools/list_changed`:
  - after an `initialize` handshake, to the client;
  - in revision `2026-07-28`, on each `subscriptions/listen` request that asks for `toolsListChanged`.
- **Cancellation.** The client cancels a request with `notifications/cancelled`. Its `requestId` is the id of the request.

## Design notes

*This section is not normative.*

MCP gives an unknown tool as a protocol error. All other problems come back as tool results, so that a model can see them and correct its call.

Many MCP clients open the session with `initialize`. A server through stdio serves these clients, and also clients of revision `2026-07-28`. Through HTTP, a server of an earlier revision can omit `Mcp-Session-Id` and keep no state. So the server answers the handshake without a session, and each later request is complete in itself. An application does not need a bridge for these clients.
