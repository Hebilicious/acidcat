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

## Events

The server serves events through the MCP events extension, `io.modelcontextprotocol/events`, with push delivery. It serves the extension only in revision `2026-07-28`, and only if the view has events. The extension is a draft: SEP-3415 at commit `b08e4f9`. The rules of the extension apply, with the choices below.

- **Capabilities.** The result of `server/discover` has `"extensions": { "io.modelcontextprotocol/events": {} }` in its capabilities. The server sends no `notifications/events/list_changed`.
- **Listing.** `events/list` gives one entry for each event in the view. Its `name` is the id. Its `description` is the description of the event. Its `delivery` is `["push"]`. Its `inputSchema` is the [bundled](../catalog.md#bundling) input schema, and its `payloadSchema` is the bundled payload schema, or `{ "type": "object" }` if the event has no payload schema. The result has no `nextCursor`.
- **Subscribing.** `events/stream` subscribes. `params.name` is the id, `params.arguments` is the input, and `params.cursor` and `params.maxAgeMs` are the cursor and `maxAgeMs`. `events/poll` and `events/subscribe` answer with the error `Unsupported`, with `data: { "feature": "deliveryMode", "value": "poll" }` or `"webhook"`.
- **Failures before the first occurrence.**

  | Kind | JSON-RPC error |
  | --- | --- |
  | `unknown-capability` | `NotFound` (`-32023`), with `data: { "kind": "event" }` |
  | `invalid-input` | `-32602` |
  | `internal` | `-32603` |

- **Start.** When the subscription starts, the server sends `notifications/events/active` with `truncated: false` and no `cursor`.
- **Occurrences.** Each occurrence is a `notifications/events/event`. Its params are the occurrence without `truncated`. Before an occurrence with `"truncated": true`, the server sends `notifications/events/active` with `truncated: true`, and with the cursor of the occurrence if it has one.
- **Heartbeat.** The server sends `notifications/events/heartbeat` when it has sent nothing on the stream for 15 seconds. Its `cursor` is the cursor of the last occurrence, or `null`.
- **Ending.**

  | End | Messages |
  | --- | --- |
  | Complete | The result of `events/stream`: `{ "resultType": "complete" }` |
  | Cancelled | Nothing |
  | `internal` | `notifications/events/terminated`, with the error `-32603` and the message of the call failure. Then the result of `events/stream` |

- **Subscription id.** Each `notifications/events/*` message has the id of the `events/stream` request in `params._meta["io.modelcontextprotocol/subscriptionId"]`. So does the result.
- **Transports.** Through HTTP, the answer to `events/stream` is a stream of server-sent events: one `data:` field with one JSON-RPC message for each message. When the client closes the request, the subscription is cancelled. Through stdio, the messages go to standard output, and `notifications/cancelled` with the id of the `events/stream` request cancels the subscription.
- **Earlier revisions.** A client that opens the session with the `initialize` handshake gets no events. The capabilities of `initialize` have no `extensions` member for events.

## HTTP

- The server uses one URL. It SHOULD be `/mcp` on the origin of the application.
- The server uses MCP revision `2026-07-28`. This revision keeps no state on the server between requests. The server rejects revisions that keep state.
- The server answers `server/discover`, `tools/list` and `tools/call`. If the view has events, it also answers `events/list` and `events/stream`.
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

## Earlier revisions through HTTP

Many MCP clients open the session with the `initialize` handshake of revision `2025-11-25` or `2025-06-18`. A server through HTTP SHOULD serve the `initialize` handshake of revision `2025-11-25`. It MAY serve the `initialize` handshake of earlier revisions. The server keeps no state for the handshake.

- **Revision of a request.** The `MCP-Protocol-Version` header gives the revision. A request with no header, and with no revision `2026-07-28` in `params._meta`, uses the handshake.
- **Methods.** The server answers `initialize`, `ping`, `tools/list` and `tools/call`. `initialize` gives the revision of the client if the server serves it. If not, it gives the latest revision that the server serves with that handshake. Its capabilities are `"tools": { "listChanged": false }`.
- **No session.** The response has no `Mcp-Session-Id` header. The server answers a notification with 202 and no body.
- **Errors.** A JSON-RPC error has the HTTP status 200. The rejections of [HTTP](#http) stay the same.
- **Results.** A result has no `_meta`, `resultType`, `ttlMs` or `cacheScope` member. These members are only in revision `2026-07-28`.

A translation layer in front of a server of revision `2026-07-28` can serve the handshake. It sends each request to the server as `server/discover`, `tools/list` or `tools/call`, and changes the result.

## Stdio

The client starts the server as a process. The client writes JSON-RPC messages to the standard input of the process, and the server writes JSON-RPC messages to its standard output.

- **Messages.** Each message is one line of UTF-8 JSON, which ends with a newline. A message contains no newline. Standard output MUST contain only these messages. The server writes its logs to standard error.
- **Lines that are not messages.** The server ignores an empty line. It answers a line that is not JSON with the JSON-RPC error `-32700` and `"id": null`. The session stays open.
- **One session.** The process is one session. The session opens when the process starts. When standard input ends, the session closes: the server cancels the calls in progress, and the process exits. The server does not have to answer the requests that it did not answer before.
- **Revisions.** The server MUST serve MCP revision `2026-07-28`, and the `initialize` handshake of revision `2025-11-25`. It MAY serve the `initialize` handshake of earlier revisions. A request of revision `2026-07-28` gives its revision in `params._meta["io.modelcontextprotocol/protocolVersion"]`. A client of an earlier revision opens the session with `initialize`.
- **Version negotiation.** `server/discover` gives each revision that the server serves in `supportedVersions`. `initialize` gives the revision of the client if the server serves it. If not, it gives the latest revision that the server serves with that handshake.
- **Methods.** The server serves `server/discover`, `subscriptions/listen`, `initialize`, `ping`, `tools/list` and `tools/call`. If the view has events, it also serves `events/list` and `events/stream` in revision `2026-07-28`.
- **Changes of the tools.** The server declares `"tools": { "listChanged": true }` in its capabilities. When the set of available capabilities changes, the server MUST send `notifications/tools/list_changed`:
  - after an `initialize` handshake, to the client;
  - in revision `2026-07-28`, on each `subscriptions/listen` request that asks for `toolsListChanged`.
- **Cancellation.** The client cancels a request with `notifications/cancelled`. Its `requestId` is the id of the request.

## Design notes

*This section is not normative.*

Push delivery holds the state of a subscription only for the time of the `events/stream` request. Thus a server through HTTP keeps no state between requests, and serves events too. Poll delivery needs a cursor that the server can replay from at any time, and webhook delivery needs state that lives longer than a request. Not all providers have these.

MCP gives an unknown tool as a protocol error. All other problems come back as tool results, so that a model can see them and correct its call.

Many MCP clients start a local server as a process and open the session with `initialize`. A server through stdio serves these clients, and also clients of revision `2026-07-28`. Through HTTP, each request of revision `2026-07-28` is complete in itself. The handshake of earlier revisions keeps no state either, because a server through HTTP does not have to give a session. So a server can serve both without state.

## Roadmap

- Follow SEP-3415 until MCP accepts it, and then follow the accepted text. The numbers of its errors are not final.

- Remove [Earlier revisions through HTTP](#earlier-revisions-through-http) when the official MCP SDKs use revision `2026-07-28` by default. The default of the official TypeScript client is the `initialize` handshake of revision `2025-11-25`. The test of the MCP binding in the aircon example uses this default. It fails when the default changes.
