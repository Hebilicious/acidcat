# AcidCat specification

AcidCat describes what an application can do in one document, the **catalog**. Every surface of the application is generated from that catalog, in whatever language the surface needs. A web app, a taskbar widget, an iOS or Android app, a command line, an MCP server, a REST or GraphQL API: one catalog, many targets.

```
                        catalog
          (one document: what the application can do)
                           │
          ┌────────────────┼──────────────────┐
       provider         bindings            clients
     (performs the    (rules that turn    (web, iOS, Android,
      capabilities)    the catalog into    desktop, cli, mcp,
                       one kind of         rest, graphql, …)
                       surface)
```

## Vocabulary

These terms have exactly these meanings throughout the specification.

| Term | Meaning |
| --- | --- |
| **Catalog** | The JSON document that lists an application's capabilities and targets. It is the single source of truth: written once, checked at build time, and matched by every implementation in every language. See [Catalog](catalog.md). |
| **Capability** | One thing a caller can do or ask for, such as `aircon.power.set`. It has an id, a description, an input, an output, failures, an audience, and optional hints and state. |
| **Id** | A capability's stable dotted name. Every surface name is derived from it. |
| **Namespace** | The first segment of an id. It groups the capabilities of one domain. |
| **Failure** | A way a capability can decline that its catalog entry declares, such as `Offline`. A failure is data returned to the caller, not an error of the call. |
| **Target** | A named audience that capabilities can be offered to, such as `web`, `ios`, `cli` or `mcp`. The catalog declares its targets, and the bindings each one uses. |
| **Audience** | The targets a capability is offered to. A capability with no audience reaches no target. |
| **View** | The part of the catalog that one target sees: the capabilities whose audience names that target. A view is itself a catalog. |
| **Binding** | The rules that turn a view into one kind of surface. A **protocol binding** defines a surface on the wire, such as MCP, HTTP, GraphQL or a CLI. A **language binding** defines a surface in code, such as TypeScript or Swift. See [Bindings](bindings/README.md). |
| **Provider** | The code that performs capabilities. It can be written in any language. |
| **Client** | Anything that calls capabilities through a binding: an app, an agent, a script. |
| **Session** | The context one client's invocations run in. It carries identity and owns the work it starts. |
| **Invocation** | One call: an id and an input in, exactly one outcome out. See [Invocation](invocation.md). |
| **Outcome** | What an invocation ends with: a **value**, a **failure**, or a **call failure** of one of five kinds. |
| **Availability** | Whether a capability can run in a session right now, with a reason when it cannot. It can change over time. |
| **State** | An optional value that a capability exposes for clients to observe, such as the room temperature. |

## Documents

| Document | Covers |
| --- | --- |
| [Catalog](catalog.md) | The document format: targets, capabilities, ids, schemas, views, change, extensions |
| [Invocation](invocation.md) | Outcomes, availability, sessions, cancellation, concurrency, long work, state |
| [Bindings](bindings/README.md) | What every binding defines, the rules for remote bindings, and the bindings this specification provides |
| [Extensions](extensions/README.md) | Optional conventions: attachments, pagination |
| [Packages](../packages/README.md) | The `acid-cat` command line, the catalog libraries, and the planned cores for Effect and for plain TypeScript |
| [Conformance](conformance.md) | What makes a catalog, a provider or a binding conforming |
| [Adoption](adoption.md) | How Jarette's Box and heb-stack move onto this specification |
| [Divergence inventory](../history/divergence.md) | How the first decisions were reached, as a record |

[`examples/aircon.pkl`](../examples/aircon.pkl), rendered to [`aircon.acidcat.json`](../examples/aircon.acidcat.json), is a complete catalog for an air conditioner that can be controlled over Wi-Fi. [`schemas/`](../schemas) holds the JSON Schemas for the catalog and for outcomes.

## Conventions

- RFC 2119 words (MUST, SHOULD, MAY) appear only where a requirement is meant. Rationale sections are not normative.
- Schemas inside a catalog are JSON Schema 2020-12.
- The core does not depend on any language or library. Bindings depend on the core, and never the reverse.
