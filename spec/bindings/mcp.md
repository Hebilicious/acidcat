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

The server serves events through the MCP events extension, `io.modelcontextprotocol/events`. It serves the extension only in revision `2026-07-28`, and only if the view has events. The extension is a draft: SEP-3415 at commit `b08e4f9`. The rules of the extension apply, with the choices below. The server serves [push](#push) delivery. It SHOULD serve [poll](#poll) delivery. It serves [webhook](#webhook) delivery if the deployment turns it on. A server that keeps no state between requests serves push only.

- **Capabilities.** The result of `server/discover` has `"extensions": { "io.modelcontextprotocol/events": {} }` in its capabilities. The server sends no `notifications/events/list_changed`.
- **Listing.** `events/list` gives one entry for each event in the view. Its `name` is the id. Its `description` is the description of the event. Its `delivery` lists the modes that the server serves, in the order `push`, `poll`, `webhook`. Its `inputSchema` is the [bundled](../catalog.md#bundling) input schema, and its `payloadSchema` is the bundled payload schema, or `{ "type": "object" }` if the event has no payload schema. The result has `resultType: "complete"`, and no `nextCursor`.
- **Subscription parameters.** In `events/stream`, `events/poll` and `events/subscribe`, `params.name` is the id, `params.arguments` is the input, and `params.cursor` and `params.maxAgeMs` are the cursor and `maxAgeMs`. An absent cursor and a `null` cursor are the same.
- **Failures before the first occurrence.**

  | Kind | JSON-RPC error |
  | --- | --- |
  | `unknown-capability` | `NotFound` (`-32023`), with `data: { "kind": "event" }` |
  | `invalid-input` | `-32602` |
  | `internal` | `-32603` |

- **Earlier revisions.** A client that opens the session with the `initialize` handshake gets no events. The capabilities of `initialize` have no `extensions` member for events.

### Subscriptions that outlive a request

A poll lease and a webhook subscription continue after the request that started them. Each one holds a subscription in a session of its own. The session opens with the identity of the client of that request, and with the services that the deployment gives to that request. The session closes when the lease or the webhook subscription ends. Thus the server keeps state between requests for poll and webhook delivery. This state is soft: a server that restarts loses it, and clients start again with their cursors.

### Push

`events/stream` subscribes, and its answer carries the occurrences.

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

### Poll

`events/poll` reads the occurrences of a **poll lease**. A lease holds one subscription and a buffer of its occurrences.

- **Lease key.** The key of a lease is the identity of the client, or none if the deployment gives no identity, the id, and the [canonical JSON](#canonical-json) of the input. Two polls with the same key read the same lease.
- **Lease time.** Each poll renews its lease. A lease that gets no poll for the lease time ends, and its subscription is cancelled. The deployment sets the lease time. The default is 5 minutes.
- **Buffer.** The lease keeps the occurrences in order, each at a position. The deployment sets the size of the buffer. The default is 1000 occurrences. When the buffer is full, the lease removes the oldest occurrence.
- **Cursor.** The cursor of a poll is a string that only the server reads. It tells the lease, the position in its buffer, and the cursor of the last occurrence that the provider gave, if any.

| Request | Result |
| --- | --- |
| No cursor, and no lease | The server starts a lease with a new subscription that starts now. The result has no occurrences, and the cursor of the start of the lease |
| No cursor, and a lease | No occurrences, and the cursor of the newest position of the lease |
| A cursor of the lease | The occurrences after the position of the cursor, in order |
| A cursor of the lease, older than its buffer | The occurrences in the buffer, and `truncated: true` |
| A cursor that is not of a lease, and a lease with the key exists | No occurrences, the cursor of the newest position of the lease, and `truncated: true` |
| A cursor that is not of a lease, and no lease with the key | The server starts a lease. If the cursor has a cursor of the provider, the subscription resumes after it, with `maxAgeMs`. If not, the subscription starts now, and the result has `truncated: true`. The result has no occurrences, and the cursor of the start of the new lease |

- **Result.** The result has `resultType: "complete"`, `events`, `cursor`, `truncated`, `hasMore` and `nextPollMs`. Each item of `events` is an occurrence without `truncated`. If an occurrence in `events` has `"truncated": true`, the result has `truncated: true`. `cursor` is the cursor of the position of the last occurrence in `events`. If `events` is empty, it is the cursor that the table gives, or else the cursor of the request.
- **Cursors of other modes.** A cursor that is not a poll cursor, for example the cursor of an occurrence of push delivery, has no cursor of the provider in it.
- **Size.** `params.maxEvents` limits the number of occurrences. It is an integer that is 1 or more. Another value gets the error `-32602`. The default is 100. If more occurrences are in the buffer, the result has `hasMore: true`.
- **Next poll.** `nextPollMs` is 2000. The deployment can change it.
- **Ending.** When the subscription of a lease is complete, the lease keeps its buffer until the lease ends. When the subscription ends with `internal`, the next poll with the key gets the error `-32603` with the message of the call failure, and the lease ends. That poll gets no occurrences, also if the buffer has occurrences.
- **Failures.** A poll with a failure before the first occurrence starts no lease.

### Webhook

The server sends occurrences in HTTP `POST` requests to a URL of the client. Webhook delivery is off unless the deployment turns it on. It is only through [HTTP](#http). The [Standard Webhooks](https://github.com/standard-webhooks/standard-webhooks/blob/main/spec/standard-webhooks.md) specification gives the signatures.

- **Identity.** The deployment gives the identity of the client of each request: the **principal**. A request to `events/subscribe` or `events/unsubscribe` with no principal gets the error `Forbidden` (`-32024`).
- **Subscription key.** The key of a webhook subscription is the principal, `params.delivery.url` as the client sent it, the id, and the canonical JSON of the input. Its **subscription id** is `sub_` and the first 16 hexadecimal digits of the SHA-256 hash of the canonical JSON of `[principal, url, id, input]`.
- **`events/subscribe`.** `params.delivery` is `{ "mode": "webhook", "url", "secret" }`. `params.ttlMs` suggests the lifetime.
  - The URL MUST use `https`. The secret MUST be `whsec_` and the base64 of 24 to 64 bytes. If not, the error is `-32602`.
  - If no subscription has the key, the server verifies the URL (see below), starts the subscription, and answers.
  - If a subscription has the key, the server renews it: it grants a new lifetime, and replaces the secret. The cursor of the request changes nothing. For 5 minutes after the secret changes, the server signs with the old secret and the new secret.
  - The result is `{ "resultType": "complete", "id", "refreshBefore", "cursor", "truncated": false, "deliveryStatus" }`. `id` is the subscription id. `refreshBefore` is the time at which the subscription ends, as an RFC 3339 date and time. `cursor` is the [watermark](#watermark), or `null`. `deliveryStatus` has `active: true`, `lastDeliveryAt`, and `lastError`, which is `null` after a delivery that succeeds.
- **Lifetime.** The grant is `ttlMs`, but not more than the maximum lifetime and not less than the minimum lifetime of the deployment. The defaults are 1 hour and 1 minute. With no `ttlMs`, or with `ttlMs: null`, the grant is the maximum lifetime. The server grants no subscription with no expiry. When the lifetime ends with no renewal, the subscription is cancelled.
- **Limit.** The deployment sets the maximum number of webhook subscriptions for one principal. The default is 100. A new subscription over the limit gets the error `ResourceExhausted` (`-32025`), with `data: { "limit": "subscriptions", "max" }`. A new subscription counts for the limit from the moment that the server accepts the request, also while the server verifies the URL.
- **Verification.** The server sends nothing to a URL until the endpoint agrees to get deliveries, for each pair of principal and URL. The URL is `params.delivery.url` as the client sent it. The URL agrees if it matches the allowlist of the deployment, or if the endpoint answers a verification. To verify, the server sends the control message `{ "type": "verification", "challenge": <random text> }`, with the headers of a delivery. The endpoint agrees if it answers with a `2xx` status and the JSON `{ "challenge": <the same text> }`. The server compares the two texts in constant time. If the endpoint does not agree, the error is `CallbackEndpointError` (`-32027`) with `data: { "reason" }`: `challenge_failed`, `connection_refused`, `timeout`, `tls_error`, `http_4xx` or `http_5xx`. A `3xx` status is `http_4xx` for a delivery, and `challenge_failed` for a verification. A failure to resolve the host name, or an address that is not allowed, is `connection_refused`. The server keeps each verification while the process runs.
- **Delivery.** Each occurrence is one `POST`. The body is the occurrence without `truncated`, and its `cursor` is the watermark after this delivery, or no `cursor`. Before an occurrence with `"truncated": true`, the server sends the control message `{ "type": "gap", "cursor" }`, with the watermark, or `null`. Each request has the headers `Content-Type: application/json`, `webhook-id`, `webhook-timestamp`, `webhook-signature` and `X-MCP-Subscription-Id`. `webhook-id` is `msg_` and random letters and digits, or `msg_<type>_` and random letters and digits for a control message. The signature is `v1,` and the base64 of the HMAC-SHA256 of `<webhook-id>.<webhook-timestamp>.<body>`, with the bytes of the secret after `whsec_`.
- **Order and retries.** The server sends the deliveries of one subscription one at a time, in order. It sends a delivery again after a status that is not `2xx`, with a longer wait each time, for a maximum of 5 attempts in 15 minutes. It makes no attempt whose wait ends after the 15 minutes. After that, it abandons the delivery. A `410` or a `413` status abandons the delivery at once. Each new attempt has the same `webhook-id`, and a new timestamp and signature. The server waits 5 seconds for each answer.
- **Watermark.** The watermark is the cursor of the provider of the last occurrence whose delivery succeeded or was abandoned. It is `null` until such an occurrence has a cursor.
- **Network safety.** For each request, the server resolves the host name of the URL, and connects only to an address that is globally routable. The deployment can allow other addresses, for example for tests. The server connects to the address that it checked, with the host name in the `Host` header and in TLS. It does not follow redirects.
- **Ending.** When the subscription ends with `internal`, the server sends the control message `{ "type": "terminated", "error": { "code": -32603, "message" } }`, and the subscription ends. When the subscription is complete, it ends with no message.
- **`events/unsubscribe`.** `params.name`, `params.arguments` and `params.delivery.url` give the key, with the principal of the request. The server cancels that subscription, and answers `{ "resultType": "complete" }`. If no subscription has the key, the error is `NotFound` (`-32023`) with `data: { "kind": "subscription" }`.
- **Off.** If webhook delivery is off, or through stdio, `events/subscribe` and `events/unsubscribe` answer with the error `Unsupported`, with `data: { "feature": "deliveryMode", "value": "webhook" }`.

### Canonical JSON

The canonical JSON of a value is its JSON text with no spaces, with the keys of each object in code point order, and with strings and numbers as the [canonical form](../catalog.md#canonical-form) writes them.

## HTTP

- The server uses one URL. It SHOULD be `/mcp` on the origin of the application.
- The server uses MCP revision `2026-07-28`. This revision keeps no state on the server between requests. The server rejects revisions that keep state. Poll leases and webhook subscriptions are the only state that the server keeps between requests (see [Subscriptions that outlive a request](#subscriptions-that-outlive-a-request)).
- The server answers `server/discover`, `tools/list` and `tools/call`. If the view has events, it also answers `events/list`, `events/stream`, `events/poll`, `events/subscribe` and `events/unsubscribe`.
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
- **Methods.** The server serves `server/discover`, `subscriptions/listen`, `initialize`, `ping`, `tools/list` and `tools/call`. If the view has events, it also serves `events/list`, `events/stream`, `events/poll`, `events/subscribe` and `events/unsubscribe` in revision `2026-07-28`.
- **Changes of the tools.** The server declares `"tools": { "listChanged": true }` in its capabilities. When the set of available capabilities changes, the server MUST send `notifications/tools/list_changed`:
  - after an `initialize` handshake, to the client;
  - in revision `2026-07-28`, on each `subscriptions/listen` request that asks for `toolsListChanged`.
- **Cancellation.** The client cancels a request with `notifications/cancelled`. Its `requestId` is the id of the request.

## Design notes

*This section is not normative.*

Push delivery holds the state of a subscription only for the time of the `events/stream` request. Poll and webhook delivery keep a subscription between requests, in a session of its own. A server through HTTP keeps no other state between requests. Webhook delivery is off by default because it needs the identity of each client, an endpoint that agrees, and a network policy that the deployment chooses.

MCP gives an unknown tool as a protocol error. All other problems come back as tool results, so that a model can see them and correct its call.

Many MCP clients start a local server as a process and open the session with `initialize`. A server through stdio serves these clients, and also clients of revision `2026-07-28`. Through HTTP, each request of revision `2026-07-28` is complete in itself. The handshake of earlier revisions keeps no state either, because a server through HTTP does not have to give a session. So a server can serve both without state.

## Roadmap

- Follow SEP-3415 until MCP accepts it, and then follow the accepted text. The numbers of its errors are not final.

- Remove [Earlier revisions through HTTP](#earlier-revisions-through-http) when the official MCP SDKs use revision `2026-07-28` by default. The default of the official TypeScript client is the `initialize` handshake of revision `2025-11-25`. The test of the MCP binding in the aircon example uses this default. It fails when the default changes.
