# AcidCat

**AcidCat** (Application Capability IDentification Category) is a specification for describing what an application can do once, and serving it everywhere. An application writes a **catalog**: one language-neutral document, checked at build time, listing its capabilities, its targets, and which targets see which capabilities. Every surface is generated from that catalog by a **binding**, in whatever language the surface needs: a web app, a taskbar widget, an iOS or Android app, a command line, an MCP server, a REST or GraphQL API.

One catalog, many targets. Start with [the specification](spec/README.md), and [the air-conditioner example](examples/aircon.pkl), written in Pkl and rendered to [JSON](examples/aircon.acidcat.json).

Status: **draft 0.1, not published.** AcidCat started in Jarette's Box, where it runs in production, and was refined in heb-stack. [Adoption](spec/adoption.md) says how both move onto this specification.

## Layout

A monorepo: Moon runs every task, and proto pins every toolchain.

| Path | Holds |
| --- | --- |
| `spec/` | The specification: the catalog, invocation, bindings, extensions, conformance, and adoption |
| `schemas/` | JSON Schemas for the catalog and for outcomes |
| `examples/` | Complete catalogs, written in Pkl, with the canonical JSON each one renders to |
| `packages/` | What this repository distributes, under the name `acid-cat`: the `acid-cat` command line, and the catalog libraries for TypeScript, Python, Go, Rust and Pkl. Two cores will join them: one written in Effect, one in plain TypeScript. See [packages/README.md](packages/README.md) |
| `adoption/` | Tools that bring existing implementations onto the specification, such as the catalog exporter for Jarette's Box |
| `scripts/` | Repository checks behind the Moon tasks |
| `history/` | How the first decisions were reached from Jarette's Box and heb-stack |

## Tasks

The toolchains (Moon, Node, pnpm, Pkl, Python, Go and Rust) are pinned in `.prototools`. Run `pnpm install` once.

| Command | Purpose |
| --- | --- |
| `moon run examples` | Render every example catalog from Pkl, in canonical form |
| `moon run check` | Check that every example is rendered and canonical, and that every catalog and fixture conforms |
| `moon run :test` | Test every package |
| `moon run verify` | Every check above |
| `pnpm exec acid-cat …` | Run the command line |
