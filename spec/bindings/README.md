# Bindings

A **binding** turns a target's [view](../catalog.md#views) into one kind of surface. A binding is written once and works for every catalog: the MCP binding serves an air conditioner and a bartering planner alike.

- A **protocol binding** defines a surface on the wire. Any language can implement it, because the wire is fixed.
- A **language binding** defines a surface in code: how a capability looks as a function, a type and an observable value in that language. Apps (web, desktop, iOS, Android) use language bindings, either in-process or over a protocol binding.

A target lists the bindings that serve it. One target can use several, as the page uses both the TypeScript and WebMCP bindings.

## What a binding defines

Every binding document MUST state:

1. **Names.** How an id becomes a surface name. Names are derived from the id alone.
2. **Input.** How a client supplies the input.
3. **Outcomes.** How each outcome and each [call failure kind](../invocation.md#call-failures) is represented, in a way the client can tell apart.
4. **Listing.** How a client learns what the target serves, including [availability](../invocation.md#availability).
5. **Cancellation.** How a client cancels a call.

It MAY also state how [state](../invocation.md#state) is observed, how `readOnly` is used, and which [extensions](../extensions/README.md) it supports.

A binding serves exactly its target's view, and nothing outside it. A binding holds no list of capabilities of its own: it derives everything from the catalog, so a new capability needs no change to the binding.

## Remote bindings

A remote binding serves clients over the network. Before it opens a session or decodes the protocol, it MUST refuse a request:

- whose method the binding does not accept;
- whose `Origin` header names an origin the deployment does not allow;
- whose media type is not the protocol's;
- whose body is longer than the deployment's limit, counting the bytes as they arrive rather than trusting `Content-Length`;
- whose body is not valid UTF-8, when the protocol is text.

Each remote binding gives the status codes it uses, and states whether it accepts requests without an `Origin` header. The values of the limits are deployment configuration.

## Bindings in this specification

| Name | Kind | Surface |
| --- | --- | --- |
| [`typescript`](typescript.md) | Language | Handles with `invoke`, availability and state, for TypeScript and JavaScript |
| [`webmcp`](webmcp.md) | Protocol | WebMCP tools in the page, for in-page agents |
| [`mcp`](mcp.md) | Protocol | An MCP server over HTTP |
| [`cli`](cli.md) | Protocol | A command line generated from the catalog |
| [`http`](http.md) | Protocol | JSON over HTTP |
| [`graphql`](graphql.md) | Protocol | A GraphQL schema generated from the catalog |

Any other binding, such as Swift, Kotlin, gRPC or a taskbar widget, can be written to the same contract. An application that does so names it `<prefix>:<name>` until it is added here.
