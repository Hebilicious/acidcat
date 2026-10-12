# AcidCat

**AcidCat** (Application Capability IDentification Category) is a specification for describing what an application can do once, and serving it everywhere. An application writes a **catalog**: one language-neutral document, checked at build time, listing its capabilities, its targets, and which targets see which capabilities. Every surface is generated from that catalog by a **binding**, in whatever language the surface needs: a web app, a taskbar widget, an iOS or Android app, a command line, an MCP server, a REST or GraphQL API.

One catalog, many targets. Start with [the specification](spec/README.md), and [the air-conditioner example](examples/aircon.pkl), written in Pkl and rendered to [JSON](examples/aircon.acidcat.json).

Status: **draft 0.1, not published.** AcidCat started in Jarette's Box, where it runs in production, and was refined in heb-stack. [Adoption](spec/adoption.md) says how both move onto this specification.

## Layout

| Path | Holds |
| --- | --- |
| `spec/` | The specification: the catalog, invocation, bindings, extensions, conformance, and adoption |
| `schemas/` | JSON Schemas for the catalog and for outcomes |
| `toolchain/` | `acidcat check`, `format` and `view`: the build-time tool for catalogs |
| `sdk/` | Libraries for writing a catalog in Pkl, TypeScript, Python, Go or Rust, all producing the same canonical JSON |
| `examples/` | Complete catalogs, written in Pkl, with the JSON each one renders to |
| `adoption/` | Tools that bring existing implementations onto the specification, such as the catalog exporter for Jarette's Box |
| `conformance/` | The conformance kit every implementation will run |
| `ref/ts/` | The TypeScript reference implementation, starting from heb-stack's kernel |
| `site/` | The static site that will publish the specification |
| `scripts/` | Repository checks behind the Moon tasks |
| `history/` | How the first decisions were reached from Jarette's Box and heb-stack |

## Layers

1. **The prose and the schemas** are normative. Implementations in any language read them.
2. **The toolchain** checks catalogs at build time, and **the SDKs** write them.
3. **The conformance kit** will judge any implementation from outside, by its catalog and by its bindings' behaviour.

Libraries such as Effect and XState belong to the reference implementation, not to the specification.

## Tasks

The toolchains (Moon, Node, pnpm, Pkl, Python, Go and Rust) are pinned in `.prototools`.

| Command | Purpose |
| --- | --- |
| `moon run examples` | Render every example catalog from Pkl, in canonical form |
| `moon run check` | Check that every example is rendered and canonical, and that every catalog and fixture conforms |
| `moon run toolchain` | Test the toolchain |
| `moon run sdk-typescript`, `sdk-python`, `sdk-go`, `sdk-rust` | Test one SDK against the air-conditioner catalog and the canonical fixture |
| `moon run verify` | Every check above |
