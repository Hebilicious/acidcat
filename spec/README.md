# Specification

The normative text, in RFC 2119 terms. Start from [the divergence inventory](divergence.md). Each closed row becomes a section here, and the spec is complete when no row is open.

Bindings for each surface (WebMCP, MCP, CLI, RPC) are separate documents that depend on the core, never the reverse.

## Sections

| Section | Covers | Rows |
| --- | --- | --- |
| [Targets and audience](targets.md) | Core and extension targets, audience, the page | D1–D3 |
| [Identifiers and namespaces](identifiers.md) | Id grammar, namespaces, reserved names | D4 |
| [Manifest](manifest.md) | The document each target serves | D7 |
| [Invocation](invocation.md) | Outcomes, expected failures, invocation failure kinds | D13 |
| [Attachments](attachments.md) | Handles, metadata, lifetime | D8 |
| [Sessions](sessions.md) | Identity and the session lifecycle | D9 |
| [Collections](collections.md) | Bounds and pages | D10 |
| [Concurrency](concurrency.md) | Owner policies and what callers observe | D12 |
| [Remote transports](transport.md) | Request screening and body limits | D14 |
| [Conformance](conformance.md) | What the kit checks and what stays in applications | D17 |

## Bindings

| Binding | Rows |
| --- | --- |
| [MCP](bindings/mcp.md) | D15 |
| [WebMCP](bindings/webmcp.md) | D16 |

Each section ends with a non-normative rationale that records why the decision was made and what each implementation has to change.
