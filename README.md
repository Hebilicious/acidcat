# AcidCat

**AcidCat** (Application Capability IDentification Category) is a specification for describing what an application can do once, and serving it everywhere. An application writes a **catalog**: one language-neutral document listing its capabilities, its targets, and which targets see which capabilities. Every surface is generated from that catalog by a **binding**, in whatever language the surface needs: a web app, a taskbar widget, an iOS or Android app, a command line, an MCP server, a REST or GraphQL API.

One catalog, many targets. Start with [the specification](spec/README.md), and [the air-conditioner example](examples/aircon.pkl), written in Pkl and rendered to [JSON](examples/aircon.acidcat.json).

Status: **draft 0.1, not published.** AcidCat started in Jarette's Box, where it runs in production, and was refined in heb-stack. [Adoption](spec/adoption.md) says how both move onto this specification.

## Layout

| Path | Holds |
| --- | --- |
| `spec/` | The specification: the catalog, invocation, bindings, extensions, conformance, and adoption |
| `schemas/` | JSON Schemas for the catalog and for outcomes |
| `examples/` | Complete catalogs, written in Pkl, with the JSON each one renders to |
| `pkl/` | `Catalog.pkl`, the Pkl module for writing catalogs by hand |
| `scripts/` | The checks behind the Moon tasks |
| `adoption/` | Tools that bring existing implementations onto the specification, such as the catalog exporter for Jarette's Box |
| `lean/` | A Lean 4 model of the semantics, its proofs, and the test vectors it generates |
| `conformance/` | The conformance kit that every implementation runs |
| `ref/ts/` | The TypeScript reference implementation: the kernel and the generic adapters |
| `site/` | The static site that publishes the specification |

## Layers

1. **The prose and the schemas** are normative. Implementations in any language read them.
2. **The Lean model** states the semantics precisely and proves its invariants. It is executable, so it also generates the conformance vectors.
3. **The conformance kit** judges any implementation from outside, by its catalog and by its bindings' behaviour.

Libraries such as Effect and XState belong to the reference implementation, not to the specification.

## Tasks

The toolchains (Moon, Node, pnpm and Pkl) are pinned in `.prototools`.

| Command | Purpose |
| --- | --- |
| `moon run examples` | Render every example catalog from Pkl to JSON |
| `moon run check` | Check that every example is rendered, valid against the schema, and follows the catalog rules |
