# Bindings

A **binding** makes one kind of surface from the [view](../catalog.md#views) of a target. One binding works for all catalogs.

- A **protocol binding** makes a surface on the network or in a terminal, for example MCP or a command line. Any language can implement it.
- A **language binding** makes a surface in code, for example TypeScript. It tells how a capability looks as a function, as types and as an observable value. Apps use language bindings.

A target lists its bindings. A target can use more than one binding. For example, a web page can use `typescript` and `webmcp`.

## What a binding document tells

Each binding document MUST tell:

1. **Names.** How an id becomes a surface name. The name comes only from the id.
2. **Input.** How a client gives the input.
3. **Outcomes.** How each outcome and each [kind of call failure](../invocation.md#call-failures) looks. The client MUST be able to identify each one.
4. **Listing.** How a client finds the capabilities of the target, and their [availability](../invocation.md#availability).
5. **Cancellation.** How a client cancels a call.

It MAY also tell how a client observes [state](../invocation.md#state), how the binding uses `readOnly`, and which [extensions](../extensions/README.md) it supports.

A binding serves the view of its target and nothing more. A binding has no list of capabilities of its own. It gets all information from the definitions of the application. Thus a new capability needs no change to the binding. A binding does not read the catalog file at run time (see [Build time and run time](../catalog.md#build-time-and-run-time)).

## Remote bindings

A remote binding serves clients through the network. Before it opens a session or reads the protocol, it MUST reject a request if:

- the binding does not accept its method;
- its `Origin` header gives an origin that the deployment does not allow;
- its media type is not the media type of the protocol;
- its body is longer than the limit of the deployment. Count the bytes as they arrive. Do not trust `Content-Length`;
- its body is not valid UTF-8, for a text protocol.

Each remote binding tells its status codes. It also tells if it accepts requests that have no `Origin` header. The deployment sets the limits.

## Bindings in this specification

| Name | Kind | Surface |
| --- | --- | --- |
| [`typescript`](typescript.md) | Language | Handles in TypeScript and JavaScript |
| [`webmcp`](webmcp.md) | Protocol | WebMCP tools in a web page |
| [`mcp`](mcp.md) | Protocol | An MCP server through HTTP, or through standard input and output |
| [`cli`](cli.md) | Protocol | A command line |
| [`http`](http.md) | Protocol | JSON through HTTP |

You can write other bindings to the same rules, for example for Swift, Kotlin or gRPC. Give a new binding a name with a prefix, as in `acme:swift`.

An API whose design you want to control, for example a GraphQL API, is application code. Build it on a language binding, with the library that you prefer. The HTTP binding gives generic access to the capabilities. [`examples/aircon`](../../examples/aircon/README.md#apis) builds APIs with GraphQL, Cap'n Web and Elysia, each beside the HTTP binding, and an MCP server beside the MCP binding.
