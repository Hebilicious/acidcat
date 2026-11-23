# MCP binding

A protocol binding that serves a view as a Model Context Protocol (MCP) server. The binding has two transports:

- [HTTP](#http): a server on the network. It follows the rules for [remote bindings](README.md#remote-bindings).
- [Stdio](#stdio): a local process. The client starts the server as a process, and they exchange messages through the standard input and the standard output of that process.

A server serves one transport or both. The rules for the [server](#server) and the [tools](#tools) apply to both transports.

## Server

- The server answers `tools/list` and `tools/call`. Each transport tells how a client opens the session, and the other methods that the server answers.
- **Instructions.** The `instructions` of the server tell a model how to use the server as a whole. The server gives them in the result of `server/discover`, and in the result of `initialize` when the transport has that handshake. The application MAY give its own instructions. If it gives none, the instructions are the `description` of the catalog. If the catalog has no `description` either, the result has no `instructions`.

## Tools

- **Names and listing.** `tools/list` gives one tool for each available capability in the view. An unavailable capability is not listed. A call to it gets the same answer as a call to an unknown tool. The `name` of the tool is the id. Its `description` is the description of the capability. Its `inputSchema` is the [bundled](../catalog.md#bundling) input schema. A property of the input schema can have the member `x-mcp-header` (see [Header annotations](#header-annotations)). The tool gives it unchanged, and the server checks the header that it names through [HTTP](#headers).
- **Output schema.** If the bundled output schema has `"type": "object"`, the tool gives it as `outputSchema`. If not, the tool has no `outputSchema`.
- **Hints.** For a `readOnly` capability, `annotations.readOnlyHint` is `true`. If the capability has `destructive`, `annotations.destructiveHint` has the same value. If the capability has `idempotent`, `annotations.idempotentHint` has the same value. If the capability does not have one of these two members, the tool has no annotation for it, or the default value of MCP: `destructiveHint: true` and `idempotentHint: false`. A client cannot see a difference between the two forms. MCP gives these two annotations a meaning only when `readOnlyHint` is `false`.
- **Cancellation.** When the client cancels the request of a call, the call is cancelled. Each transport tells how the client cancels a request. The server does not have to answer a cancelled call.
- **Outcomes.**

  | Outcome | Answer |
  | --- | --- |
  | Value | A tool result. Its text content is the JSON of the value. If the tool has `outputSchema`, `structuredContent` is the value |
  | Failure | A tool result with `isError: true`. Its text content is the JSON of `{ "ok": false, "error": <failure> }` |
  | `unknown-capability` | The JSON-RPC error `-32602`. The message gives the name of the tool |
  | Other call failures | A tool result with `isError: true`. Its text content is the JSON of `{ "kind", "message" }` |

  The `ok` member identifies a failure. A call failure has no `ok` member.

### Header annotations

The member `x-mcp-header` of a property of an input schema names the header `Mcp-Param-{Name}` that mirrors the property through HTTP. The [Streamable HTTP transport](https://modelcontextprotocol.io/specification/2026-07-28/basic/transports/streamable-http#custom-headers-from-tool-parameters) of MCP gives the rules, and a client of this transport removes a tool with an annotation that breaks them from its list. A catalog MUST follow these rules in the input schema of each capability and each event. `acid-cat check` checks them on the [bundled](../catalog.md#bundling) input schema, which is the schema that clients get:

- **Location.** The annotation is on a property that a chain of `properties` members reaches from the root of the schema. The chain does not go through `items` or another array keyword, `anyOf`, `oneOf`, `allOf`, `not`, `if`, `then`, `else` or `$ref`. The root of the schema is not a property, and a type in the `$defs` of the bundled schema is not on the chain. Bundling replaces an input schema that is only a `$ref` by its type, so the properties of that type are on the chain. A property that is a `$ref` to a type is not on the chain, and neither are the properties of that type.
- **Type.** The property has the member `type` with the value `string`, `integer` or `boolean`.
- **Value.** The value is an HTTP token (`1*tchar`, [RFC 9110, section 5.6.2](https://www.rfc-editor.org/rfc/rfc9110#section-5.6.2)). It is not empty, and has no spaces and no control characters.
- **Unique.** No two annotations in one input schema have the same value without regard to case.

## Events

The server serves events through the MCP events extension, `io.modelcontextprotocol/events`. It serves the extension only in revision `2026-07-28`, and only if the view has events. The extension is the Final text of SEP-3415, at commit `6a4bf07`. The rules of the extension apply, with the choices below. The server serves [push](#push) delivery. It SHOULD serve [poll](#poll) delivery. It serves [webhook](#webhook) delivery if the deployment turns it on. A server that keeps no state between requests serves push only.

- **Capabilities.** The result of `server/discover` has `"extensions": { "io.modelcontextprotocol/events": {} }` in its capabilities. The server sends no `notifications/events/list_changed`.
- **Listing.** `events/list` gives one entry for each event in the view. Its `name` is the id. Its `description` is the description of the event. Its `delivery` lists the modes that the server serves, in the order `push`, `poll`, `webhook`. Its `inputSchema` is the [bundled](../catalog.md#bundling) input schema, and its `payloadSchema` is the bundled payload schema, or `{ "type": "object" }` if the event has no payload schema. The result has `resultType: "complete"`, and no `nextCursor`.
- **Subscription parameters.** In `events/stream`, `events/poll` and `events/subscribe`, `params.name` is the id, `params.arguments` is the input, and `params.cursor` and `params.maxAgeMs` are the cursor and `maxAgeMs`. An absent cursor and a `null` cursor are the same.
- **Headers.** The `inputSchema` of an event gives each `x-mcp-header` member of the input schema unchanged. Through HTTP, the server checks the headers of `events/stream`, `events/poll`, `events/subscribe` and `events/unsubscribe` as for `tools/call` (see [Headers](#headers)), with the input schema of the event.
- **Failures before the first occurrence.**

  | Kind | JSON-RPC error |
  | --- | --- |
  | `unknown-capability` | `NotFound` (`-32023`), with `data: { "kind": "event" }` |
  | `invalid-input` | `-32602` |
  | `internal` | `-32603` |

- **Earlier revisions.** A client that opens the session with the `initialize` handshake gets no events. The capabilities of `initialize` have no `extensions` member for events.
- **Server Card.** The entry `io.modelcontextprotocol/events` in the `extensionsInfo` of a [Server Card](#server-card) gives information about webhook delivery. It does not tell that the server serves the extension. A client learns that from `server/discover`.

### Subscriptions that outlive a request

A poll lease and a webhook subscription continue after the request that started them. Each one holds a subscription in a session of its own. The session opens with the identity of the client of that request, and with the services that the deployment gives to that request. The session closes when the lease or the webhook subscription ends. Thus the server keeps state between requests for poll and webhook delivery. This state is soft: a server that restarts loses it, and clients start again with their cursors.

### Push

`events/stream` subscribes, and its answer carries the occurrences.

- **Heartbeat interval.** `params.heartbeatMs` suggests the heartbeat interval, in milliseconds. It is an integer that is 1 or more. Another value gets the error `-32602`, and the server opens no stream. An absent `heartbeatMs` and `heartbeatMs: null` are the same: no suggestion. The server grants the suggestion, but not less than 1000 and not more than 60 000. With no suggestion, the grant is the heartbeat interval of the deployment. The default is 15 000.
- **Start.** When the subscription starts, the server sends `notifications/events/active` with `truncated: false`, the granted `heartbeatMs`, and no `cursor`.
- **Occurrences.** Each occurrence is a `notifications/events/event`. Its params are the occurrence without `truncated`. Before an occurrence with `"truncated": true`, the server sends `notifications/events/active` with `truncated: true`, the granted `heartbeatMs`, and the cursor of the occurrence if it has one.
- **Heartbeat.** The server sends `notifications/events/heartbeat` when it has sent nothing on the stream for the granted `heartbeatMs`. Its `cursor` is the cursor of the last occurrence, or `null`.
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
- **Server signature.** The deployment MAY give signing keys. Each key is a private JSON Web Key (JWK, [RFC 8037](https://www.rfc-editor.org/rfc/rfc8037)) of an Ed25519 key: `kty: "OKP"`, `crv: "Ed25519"`, a `kid` that is not empty, and `d`, the base64url of 32 bytes with no padding. The server takes the public key from `d`, and does not read `x`. Two keys with the same `kid`, or a key of another form, make the server fail when it starts. With signing keys, the `webhook-signature` header of each request, deliveries and verifications, has after its `v1,` signatures one `v1a,` signature for each key, in the order of the keys. A `v1a,` signature is `v1a,` and the base64 of the Ed25519 signature of `<webhook-id>.<webhook-timestamp>.<body>`. With no signing keys, the header has only `v1,` signatures. The header has one `v1,` signature for each secret that signs the request, and no signatures other than these `v1,` and `v1a,` signatures. The [Server Card](#server-card) gives the public keys, so signing keys need a card.
- **Egress ranges.** The deployment MAY give the IP ranges from which the server sends its requests, as CIDR text: an IPv4 address and `/` and a prefix length from 0 to 32, or an IPv6 address and `/` and a prefix length from 0 to 128. A value of another form makes the server fail when it starts. The [Server Card](#server-card) gives the ranges, so egress ranges need a card.
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
- A request to the URL of the [Server Card](#server-card) is not a JSON-RPC request. That section gives its answers.

The server rejects requests as follows. Each rejection has the header `Cache-Control: no-store`.

| Problem | HTTP status | JSON-RPC error |
| --- | --- | --- |
| The method is not `POST` | 405, with `Allow: POST` | None |
| The `Origin` is not allowed | 403 | None |
| The media type is not `application/json` | 415 | None |
| The body is too long | 413 | `-32600` |
| The body is not UTF-8, or not JSON | 400 | `-32700` |

### Headers

The client mirrors parts of the body of each request of revision `2026-07-28` into headers, as the Streamable HTTP transport of MCP tells. The server checks each header against the body. A header that does not agree gets the HTTP status 400 and the JSON-RPC error `HeaderMismatch` (`-32020`). The server makes these checks after the checks of the revision, and before it answers the request. A notification has no checks.

- **`Mcp-Method`.** The header MUST be equal to the method of the request.
- **`Mcp-Name`.** For `tools/call`, `events/stream`, `events/poll`, `events/subscribe` and `events/unsubscribe`, `params.name` MUST be a string, and the header MUST be equal to it after decoding.
- **`Mcp-Param-{Name}`.** For `tools/call`, the server takes the bundled input schema of the tool. For the four requests of the events extension that name an event, it takes the bundled input schema of the event. Each property that a chain of `properties` members reaches from the root of the schema, and that has a string `x-mcp-header`, names the header `Mcp-Param-` and that string. Header names are case-insensitive. A catalog has no `x-mcp-header` member at other locations ([Header annotations](#header-annotations)). For each such property:
  - If the argument at the path of the property is absent or `null`, the request MUST NOT have the header.
  - If not, the request MUST have the header, and its decoded value MUST agree with the argument. A string agrees with the same text. A boolean agrees with `true` or `false`. An integer agrees with a decimal text of the same number. A value of another type agrees with no header.
- **Unknown names.** For an unknown or unavailable tool, and for an unknown event, the server checks no `Mcp-Param-{Name}` header. The request gets the answer to an unknown tool or event.
- **Decoding.** A value that starts with `=?base64?` and ends with `?=` is the base64 of the UTF-8 text between them. A leading U+FEFF is part of the text. Another value is the text itself, and has only visible ASCII characters, spaces and tabs. A value that does not decode does not agree.

## Earlier revisions through HTTP

Many MCP clients open the session with the `initialize` handshake of revision `2025-11-25` or `2025-06-18`. A server through HTTP SHOULD serve the `initialize` handshake of revision `2025-11-25`. It MAY serve the `initialize` handshake of earlier revisions. The server keeps no state for the handshake.

- **Revision of a request.** The `MCP-Protocol-Version` header gives the revision. A request with no header, and with no revision `2026-07-28` in `params._meta`, uses the handshake.
- **Methods.** The server answers `initialize`, `ping`, `tools/list` and `tools/call`. `initialize` gives the revision of the client if the server serves it. If not, it gives the latest revision that the server serves with that handshake. Its capabilities are `"tools": { "listChanged": false }`.
- **No session.** The response has no `Mcp-Session-Id` header. The server answers a notification with 202 and no body.
- **Errors.** A JSON-RPC error has the HTTP status 200. The rejections of [HTTP](#http) stay the same.
- **Results.** A result has no `_meta`, `resultType`, `ttlMs` or `cacheScope` member. These members are only in revision `2026-07-28`.

A translation layer in front of a server of revision `2026-07-28` can serve the handshake. It sends each request to the server as `server/discover`, `tools/list` or `tools/call`, and changes the result. It gives each request the [headers](#headers) that the server checks. For `tools/call`, it takes the input schema of the tool from `tools/list` of the server.

## Server Card

A server through HTTP serves an MCP Server Card: a JSON document that tells a client how to connect to the server before it connects. The [Server Card extension](https://github.com/modelcontextprotocol/ext-server-card), `io.modelcontextprotocol/server-card`, gives the form of the card, at commit `28db12c` of its repository. An implementation SHOULD serve the card unless the deployment turns it off, and SHOULD let the deployment turn it off. So a client cannot expect a card from each server.

- **Location.** The URL of the card is the URL of the server and `/server-card`, for example `/mcp/server-card`. A `GET` request to it gets the card, with the HTTP status 200 and `Content-Type: application/mcp-server-card+json`. If the server serves no card, a `GET` request to it gets 404. A server that serves the events in front of another MCP server, which answers `server/discover`, serves the card of that other server: the card gives the `version` and the `supportedVersions` of the `server/discover` result of that server. For each `GET` request of the card, it sends `server/discover` to that server. If that request fails, if its result has no `serverInfo` with a `name` and a `version`, or if the version is a range, the `GET` request of the card gets 502, because the card would not agree with that server.
- **Members.** The card has these members, and no other members:
  - `$schema`: `https://static.modelcontextprotocol.io/schemas/v1/server-card.schema.json`.
  - `name`: the name that the deployment gives, or else the [default name](#default-name). It has the reverse-DNS form of the extension: 3 to 200 characters, and one `/`, for example `com.example/aircon`. It is the name of the server in a registry. The `name` of `serverInfo` in `server/discover` is the name at run time, and can be different.
  - `version`: the version of the server, the same as the `version` of `serverInfo` in `server/discover`. It is one version, not a range, as the [schema of the extension](https://github.com/modelcontextprotocol/ext-server-card/blob/28db12c/schema.ts) tells: it does not start with `^`, `~`, `<`, `>` or `=`, it has no `||` and no white space before a `-`, and no part of it before the first `-` or `+` is `x`, `X` or `*`. For example, `1.2.3` is a version, and `^1.2.3` and `1.x` are ranges.
  - `description`: the description that the deployment gives for the card, or else the [default description](#default-description). It has 1 to 100 characters.
  - `remotes`: one entry. Its `type` is `streamable-http`. Its `url` is the URL that the deployment gives, or else the URL of the server with the origin of the request of the card. A deployment behind a platform that ends TLS gives the `https` URL, because the server gets the request as `http`. Its `supportedProtocolVersions` are `2026-07-28` and each revision of the [`initialize` handshake](#earlier-revisions-through-http) that the server serves at that URL.
- **Webhook information.** If webhook delivery is on and the deployment gives [signing keys or egress ranges](#webhook), the entry of `remotes` has `extensionsInfo: { "io.modelcontextprotocol/events": { "webhooks": … } }`. `webhooks` has the members of what the deployment gives:
  - `signingKeys`: a JWK set, `{ "keys": [...] }`, with the public key of each signing key, in the order of the keys. Each public key has only `kty: "OKP"`, `crv: "Ed25519"`, the `kid` and `x`, the base64url of the public key with no padding.
  - `egressIpRanges`: the egress ranges, as the deployment gives them, in the same order.
- **Startup.** A server whose deployment gives the card a name that does not have the reverse-DNS form, a description that does not have 1 to 100 characters, or a URL that is not an absolute `http` or `https` URL with a host, fails when it starts. The server parses the URL as the [WHATWG URL Standard](https://url.spec.whatwg.org/) tells. A server with the card on and a version that is a range or is longer than 255 characters also fails when it starts. A default never makes a server fail. A server with signing keys or egress ranges and the card off also fails when it starts, because a receiver gets them only from the card.
- **Content.** The card is public. It has no sensitive information: no secret, such as a private key, a credential or a token, no private endpoint, and no internal detail of the network ([Information Disclosure](https://github.com/modelcontextprotocol/ext-server-card/blob/28db12c/docs/discovery.md#information-disclosure)).
- **Transport.** In production, the deployment serves the card through HTTPS, with TLS 1.2 or later. HTTP is only for local development ([Transport Security](https://github.com/modelcontextprotocol/ext-server-card/blob/28db12c/docs/discovery.md#transport-security)).
- **Trust.** A client uses information of `extensionsInfo` for a security decision, for example the signing keys to verify `v1a,` signatures or the egress ranges to allow addresses, only if it got the card through HTTPS from the origin of the `url` of the remote, with no redirect to another origin. It does not use such information from a card on another origin, or from a card inline in an entry of an AI Catalog. For other values, the live connection is the source of truth. See [Consistency with runtime behavior](https://github.com/modelcontextprotocol/ext-server-card/blob/28db12c/docs/discovery.md#consistency-with-runtime-behavior).
- **Headers.** The response of the card has the headers `Access-Control-Allow-Origin: *`, `Access-Control-Allow-Methods: GET`, `Access-Control-Allow-Headers: Content-Type, If-None-Match`, `Access-Control-Expose-Headers: ETag`, `Cache-Control: public, max-age=3600` and an `ETag`. A `GET` request whose `If-None-Match` header has the entity tag of the card gets 304, with no body. An `OPTIONS` request gets 204, with the same headers and no `ETag`. A request with another method gets 405, with `Allow: GET, OPTIONS`.

### Default name

The default name is `<namespace>/<server>`. It always has the reverse-DNS form.

- **Host.** The host is the host of the `url` of the remote, as the WHATWG URL Standard parses it, without the port. It is in ASCII: a host with other characters is in punycode, so `bücher.example` gives `xn--bcher-kva.example`. It is in lower case, with no `.` at its end.
- **Namespace.** The namespace is the labels of the host in reverse order, joined by `.`, with `-` in place of each character that is not a letter from `a` to `z` or `A` to `Z`, a digit, `.` or `-`. For example, `aircon.example.com` gives `com.example.aircon`, and `localhost` gives `localhost`. The namespace is `local` if the host is an IP address (an IPv6 address in `[` and `]`, or a host whose last label has only digits), if the host is empty, or if the namespace has more than 99 characters. An IP address is not a name of the server in DNS, so it gives no namespace.
- **Server.** The server part is the `name` of `serverInfo` in `server/discover`, with `-` in place of each character that is not a letter from `a` to `z` or `A` to `Z`, a digit, `.`, `_` or `-`, and only its first 100 characters. It is `mcp` if it is empty.

For example, the server `aircon` at `https://aircon.example.com/mcp` has the default name `com.example.aircon/aircon`, and at `http://127.0.0.1:3000/mcp` it has `local/aircon`.

### Default description

The default description is the first of these texts that is not empty: the `description` of the catalog, the `instructions` of `server/discover`, and the `name` of `serverInfo` in `server/discover`. For a server in front of another MCP server, which answers `server/discover` (see [Location](#server-card)), the card describes that other server, so the order is: the `instructions` of the `server/discover` result of that server, the `description` of the catalog, and the `name` of its `serverInfo`. If none of them has text, it is `MCP server`. A text of more than 100 characters becomes its first 99 characters and `…` (U+2026). The characters are Unicode code points.

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

- Remove [Earlier revisions through HTTP](#earlier-revisions-through-http) when the official MCP SDKs use revision `2026-07-28` by default. The default of the official TypeScript client is the `initialize` handshake of revision `2025-11-25`. The test of the MCP binding in the aircon example uses this default. It fails when the default changes.
