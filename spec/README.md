# AcidCat specification

AcidCat describes what an application can do in one document, the **catalog**. Each surface of the application comes from the catalog, in the language that the surface needs. Examples of surfaces are a web app, a desktop widget, a mobile app, a command line, an MCP server, and an HTTP API.

```
                         catalog
          (one document: what the application can do)
                            │
          ┌─────────────────┼──────────────────┐
      provider          bindings            clients
   (does the        (rules that make     (web, mobile,
   operations)       one kind of          desktop, cli,
                     surface)             mcp, api, …)
```

## Vocabulary

These terms have these meanings in all documents.

| Term | Meaning |
| --- | --- |
| **Catalog** | The JSON document that lists the capabilities and the targets of an application. See [Catalog](catalog.md) |
| **Capability** | One operation that a client can do, for example `aircon.power.set` |
| **Id** | The name of a capability, with dots between its segments. Each surface name comes from the id |
| **Namespace** | The first segment of an id |
| **Failure** | A result that tells why a capability did not do the operation, for example `Offline` |
| **Target** | A group of clients that can use a set of capabilities, for example `app`, `cli` or `mcp` |
| **Audience** | The targets that can use a capability. A capability with no audience is not available to any target |
| **View** | The part of the catalog that one target can see. A view is a catalog |
| **Binding** | The rules that make one kind of surface from a view. A **protocol binding** makes a surface on the network or in a terminal, for example MCP or a command line. A **language binding** makes a surface in code, for example TypeScript. See [Bindings](bindings/README.md) |
| **Provider** | The code that does the operations |
| **Client** | A program or a person that calls capabilities through a binding |
| **Session** | The context of the calls of one client. It holds the identity of the client |
| **Invocation** | One call: an id and an input go in, one outcome comes out. See [Invocation](invocation.md) |
| **Outcome** | The end of a call: a **value**, a **failure** or a **call failure** |
| **Availability** | If a capability can run now in a session. If it cannot, the availability gives a reason |
| **State** | A value of a capability that clients can observe, for example the temperature of a room |

## Documents

| Document | Contents |
| --- | --- |
| [Catalog](catalog.md) | Targets, capabilities, ids, schemas, types, views, canonical form |
| [Invocation](invocation.md) | Outcomes, availability, sessions, cancellation, concurrency, state |
| [Bindings](bindings/README.md) | The rules for all bindings, and the bindings in this specification |
| [Extensions](extensions/README.md) | Optional conventions: attachments, pagination |
| [Conformance](conformance.md) | The rules for a conforming catalog, provider and binding |

[`examples/aircon.pkl`](../examples/aircon.pkl) is a full catalog for an air conditioner. [`schemas/`](../schemas) has the JSON Schemas for the catalog and for outcomes.

## Conventions

- The words MUST, MUST NOT, SHOULD and MAY are used as in RFC 2119. Other text explains or gives examples.
- "Design notes" sections are not normative.
- The schemas in a catalog are JSON Schema 2020-12.
- This specification does not depend on a language or a library. Bindings depend on this specification. This specification does not depend on bindings.
