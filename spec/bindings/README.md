# Bindings

A **binding** makes one kind of surface from a target's [view](../catalog.md#views). One binding works for every catalog.

- A **protocol binding** makes a surface on the network or in a terminal, for example MCP or a command line. Any language can implement it.
- A **language binding** makes a surface in code, for example TypeScript. It tells how a capability looks as a function, as types and as an observable value. Applications use language bindings.

A target lists its bindings, and it can use more than one. For example, a web page can use `typescript` and `webmcp`.

## What a binding document tells

Each binding document MUST tell:

1. **Names.** How an id becomes a surface name. The name comes only from the id.
2. **Input.** How a client gives the input.
3. **Outcomes.** How each outcome and each [kind of call failure](../invocation.md#call-failures) looks. The client MUST be able to identify each one.
4. **Listing.** How a client finds the capabilities of the target, and their [availability](../invocation.md#availability).
5. **Cancellation.** How a client cancels a call.

It MAY also tell how a client observes [state](../invocation.md#state), how the binding uses `readOnly`, `destructive` and `idempotent`, and which [extensions](../extensions/README.md) it supports.

A binding SHOULD serve [events](../events.md) if its protocol can send messages that the client did not request one by one, for example a stream. A binding that serves events MUST tell:

1. **Listing.** How a client finds the events of the target.
2. **Subscribing.** How a client gives the id, the input and the cursor, and how each call failure before the first occurrence looks.
3. **Occurrences.** How each occurrence looks.
4. **Ending.** How the client sees each [end](../events.md#ending) of a subscription.
5. **Cancellation.** How a client cancels a subscription.

A binding that does not serve events MUST say so.

A binding serves its target's view and nothing more. It has no list of capabilities of its own: it gets everything from the application's definitions, so a new capability or a new event needs no change to the binding. A binding does not read the catalog file at run time (see [Build time and run time](../catalog.md#build-time-and-run-time)).

## Remote bindings

A remote binding serves clients through the network. Before it opens a session or reads the protocol, it MUST reject a request if:

- the binding does not accept its method;
- its `Origin` header gives an origin that the deployment does not allow;
- its media type is not the media type of the protocol;
- its body is longer than the limit of the deployment. Count the bytes as they arrive. Do not trust `Content-Length`;
- its body is not valid UTF-8, for a text protocol.

Each remote binding document gives its status codes, and tells whether the binding accepts requests that have no `Origin` header. The deployment sets the limits.

After these checks, the deployment MAY refuse a request, for example when it does not know the caller. It refuses before it opens a session. The answer has a status that the deployment chooses, such as `401` or `403`, the media type `application/json`, and the body `{ "message" }`. The message shows no internal data. No capability runs, and no subscription starts.

## Bindings in this specification

| Name | Kind | Surface | Events |
| --- | --- | --- | --- |
| [`typescript`](typescript.md) | Language | Handles in TypeScript and JavaScript | Async iterables |
| [`webmcp`](webmcp.md) | Protocol | WebMCP tools in a web page | None |
| [`mcp`](mcp.md) | Protocol | An MCP server through HTTP, or through standard input and output | The MCP events extension |
| [`cli`](cli.md) | Protocol | A command line | `watch`, with one line of JSON for each occurrence |
| [`http`](http.md) | Protocol | JSON through HTTP | Server-sent events |

You can write other bindings to the same rules, for example for Swift, Kotlin or gRPC. Give a new binding a prefixed name, such as `acme:swift`.

An API whose design you want to control, such as a GraphQL API, is application code. Build it on a language binding, with the library you prefer, and keep the HTTP binding for generic access to the capabilities. A GraphQL subscription comes from an event: the TypeScript binding gives an async iterable, which is the source of a GraphQL subscription through WebSockets or server-sent events.

[`examples/aircon`](../../examples/aircon/README.md#apis) builds APIs with GraphQL, Cap'n Web and Elysia, each beside the HTTP binding, and an MCP server beside the MCP binding. Its GraphQL API has a subscription to `aircon.status.changed`.
