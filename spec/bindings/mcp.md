# MCP binding

This binding serves the `mcp` target as a Model Context Protocol server over HTTP. It depends on [Targets](../targets.md), [Manifest](../manifest.md), [Invocation](../invocation.md) and [Remote transports](../transport.md).

Closes divergence row D15.

## Endpoint

The server answers one URL, which SHOULD be `/mcp` on the application's origin. It serves MCP revision `2026-07-28`, which keeps no server-side session state, and refuses revisions that require session state.

Each request is handled by a session that the server creates for the `mcp` target and disposes of once the response is complete. Nothing is carried from one request to the next.

## Screening

The binding applies [Remote transports](../transport.md#screening), and accepts requests without an `Origin` header:

| Refusal | HTTP status | JSON-RPC error |
| --- | --- | --- |
| Method other than `POST` | 405, with `Allow: POST` | none |
| `Origin` not allowed | 403 | none |
| Media type other than `application/json` | 415 | none |
| Body over the limit | 413 | `-32600` |
| Body not UTF-8, or not JSON | 400 | `-32700` |

Every refusal carries `Cache-Control: no-store`.

## Tools

`tools/list` lists one tool for each capability the session serves:

- `name` is the capability's id.
- `description` is the capability's description.
- `inputSchema` is the capability's `inputSchema` from the `mcp` manifest.
- `outputSchema` is the capability's `outputSchema` when that schema's top level states `"type": "object"`. Otherwise it is omitted.
- `annotations.readOnlyHint` is `true` when the capability is [`readOnly`](../manifest.md#document).

## Outcomes

| Outcome | Answer |
| --- | --- |
| Success | A tool result whose text content is the JSON of the value. When the tool declares `outputSchema`, `structuredContent` is the value |
| Expected failure | A tool result with `isError: true`, whose text content is the JSON of `{ "ok": false, "error": <failure> }` |
| `unknown-capability` | JSON-RPC error `-32602`, whose message names the tool |
| `cancelled` | No answer is required. If one is sent, it is a tool result with `isError: true` whose text content is the JSON of the invocation failure |
| Any other invocation failure | A tool result with `isError: true`, whose text content is the JSON of `{ "kind": <kind>, "message": <text> }` |

A client tells an expected failure from an invocation failure by the `ok` member.

The invocation's signal is aborted when the client cancels the request or closes the connection.

## Rationale

*This section is not normative.*

**The JB and HS approach is kept.** Both run a stateless server on `/mcp` that serves only revision `2026-07-28`, builds a session for each request, and names tools by their id. This document states that approach in terms of the protocol, without the library that implements it.

**Unknown tools are protocol errors, and other failures are tool results.** MCP treats an unknown tool as a protocol error, and both implementations answer `-32602`. MCP asks servers to report input validation errors as tool results, so that a model can correct its call. The other invocation failures follow the same path, and the `kind` member keeps them apart, which [Invocation](../invocation.md#invocation-failures) requires.

**The `ok` wrapper on failures.** Both implementations currently put the bare failure, or a bare `{ message }`, into the error result. A client can then only tell them apart by guessing from `_tag`. Wrapping the expected failure gives it a discriminant without changing the success answer that HS's evidence relies on.

**`outputSchema` only for objects.** MCP requires structured content to be an object. A capability whose output is not an object is still served, as text.

**Changes for each implementation.**
- Both: check the media type and UTF-8; wrap expected failures and give invocation failures their `kind`; publish `outputSchema`; pass a signal to the invocation.
- Both currently answer non-JSON bodies with `-32700`, which this binding keeps. JB's feature file, which says "invalid-request", should be corrected in JB.
