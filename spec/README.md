# AcidCat specification

An application describes what it can do in one JSON document, the **catalog**. Every **surface** of the application comes from the catalog: a command line, an MCP server, an HTTP API, tools in a web page, or handles in code. A **binding** defines how one kind of surface is made from the catalog. A **provider** runs the operations. Clients use the surfaces: a web app, a desktop widget or a mobile app uses handles in code, and an AI agent uses an MCP server.

```
                 catalog (JSON)
     what the application can do, and for whom
                       │
        ┌──────────────┼───────────────┐
     provider       bindings         surfaces ──── clients
  runs the         rules for each   CLI, MCP,      web, mobile,
  operations       kind of surface  HTTP, …        agents, …
```

The specification does not depend on a language or a library. Bindings depend on the specification, never the reverse.

## Documents

| Document | Contents |
| --- | --- |
| [Catalog](catalog.md) | Targets, capabilities, events, ids, schemas, types, views, canonical form |
| [Invocation](invocation.md) | Outcomes, availability, sessions, cancellation, concurrency, state |
| [Events](events.md) | Subscriptions, occurrences, ending, resuming |
| [Bindings](bindings/README.md) | Rules for all bindings, and the bindings this specification defines |
| [Programmatic binding](bindings/programmatic.md) | The contract of every language binding: handles, calls, outcomes, observable values, cancellation, event handles |
| [Extensions](extensions/README.md) | Optional conventions: attachments, pagination |
| [Conformance](conformance.md) | What makes a catalog, a provider and a binding conform |

[`examples/aircon/catalog/aircon.pkl`](../examples/aircon/catalog/aircon.pkl) is a complete catalog for an air conditioner. [`schemas/`](../schemas) has the JSON Schemas for catalogs, outcomes and occurrences.

## Vocabulary

Every document uses these terms with these meanings.

| Term | Meaning |
| --- | --- |
| **Catalog** | The JSON document that lists an application's capabilities, events and targets. See [Catalog](catalog.md) |
| **Capability** | One operation that a client can do, for example `aircon.power.set` |
| **Event** | A kind of thing that happens in the application and that clients can follow, for example `aircon.status.changed`. See [Events](events.md) |
| **Id** | The name of a capability or an event: segments with dots between them. Every surface name comes from the id |
| **Namespace** | The first segment of an id |
| **Failure** | A result that says why a capability did not do the operation, for example `Offline` |
| **Target** | A group of clients that can use a set of capabilities, for example `app`, `cli` or `mcp` |
| **Audience** | The targets that can use a capability or an event. A capability or an event with no audience is available to no target |
| **View** | The part of the catalog that one target can see. A view is itself a catalog |
| **Surface** | What a client uses to reach the capabilities and the events of a target: for example a command line, an MCP server, an HTTP API, WebMCP tools in a web page, or handles in code. A binding makes a surface |
| **Binding** | The rules that make one kind of surface from a view. A **protocol binding** makes a surface on the network or in a terminal, for example MCP or a command line. A **language binding** makes a surface in code, for example TypeScript or Rust. The **programmatic binding** is the contract that every language binding follows, with no language. See [Bindings](bindings/README.md) and [Programmatic binding](bindings/programmatic.md) |
| **Alias** | A short command-line name for a capability or an event. A **command alias** is one or two words; a **flag alias** is `--` and one word. Command aliases with the same first word form a **group**. A command alias whose name is a shared prefix of commands is the **prefix default** of that prefix. The **fixed input** of an alias is the part of the input that the alias always gives. The **default alias** runs when the command line gets no command. See [CLI binding](bindings/cli.md#aliases) |
| **Transport** | How a protocol binding carries messages between a client and a server, for example HTTP, or a process's standard input and output (stdio) |
| **Provider** | The code that does the operations |
| **Core** | A library that implements this specification in one language. It runs the providers and serves the bindings of each target. A program can follow this specification without a core |
| **Client** | A program or a person that calls capabilities through a binding |
| **Session** | One period in which one client calls the capabilities of one target and follows its events. It holds the client's identity. It opens, and later it closes |
| **Invocation** | One call: an id and an input go in, one outcome comes out. See [Invocation](invocation.md) |
| **Outcome** | How a call ends: a **value**, a **failure** or a **call failure** |
| **Availability** | Whether a capability can run now in a session. When it cannot, the availability gives a reason |
| **Subscription** | One client following one event with one input. It ends once: complete, cancelled, or with a call failure |
| **Occurrence** | One thing that happened, which a subscription delivers to its client. Its `data` matches the event's payload schema |
| **Cursor** | A string that marks a position in an event's occurrences. A client gives it to resume a subscription |
| **State** | A value of a capability that clients can observe, for example the temperature of a room |
| **Handle** | The surface of one capability in a language binding. Through it, a client reads the availability and the state of the capability, and calls it. An **event handle** is the surface of one event in a language binding. Through it, a client subscribes to the event. See [Programmatic binding](bindings/programmatic.md) |
| **Observable value** | A value that changes, in a language binding. A client reads the latest value, the **snapshot**. The binding tells the client after the value changes. The client can miss a value between two reads. State is an observable value, and availability usually is one. See [Programmatic binding](bindings/programmatic.md#observable-values) |
| **External call** | A call through a handle with an input that is not trusted. The handle validates the input. A **typed call** takes an input that is already decoded into the types of the language. An **external subscription** and a **typed subscription** are the same for an event handle |

## Conventions

- MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. All other text explains or gives examples.
- Sections titled "Design notes" are not normative.
- Schemas in a catalog are JSON Schema 2020-12.
