# AcidCat

**AcidCat** (Application Capability IDentification Category) is a specification for building one application interface that serves humans and agents alike. An application is a catalog of typed capabilities. Each capability has a stable namespaced id, and every surface is a projection of that catalog: the UI, in-page WebMCP tools, MCP, a command line, RPC.

Status: **draft, not published.** AcidCat started in Jarette's Box, where it runs in production, and was refined in heb-stack. The two implementations have diverged. This repository reconciles them into one specification and then becomes the source both consume.

## Layout

| Path | Holds |
| --- | --- |
| `spec/` | The normative specification, and [the divergence inventory](spec/divergence.md) that drives it |
| `schemas/` | JSON Schema for the wire contract: descriptor, manifest, result envelope |
| `lean/` | A Lean 4 model of the semantics, its proofs, and the test vectors it generates |
| `conformance/` | The black-box conformance kit every implementation runs |
| `ref/ts/` | The TypeScript reference implementation: kernel and generic adapters |
| `site/` | The static site that publishes the specification |

Each directory's README says what belongs there and what has to be true before it is filled.

## Layers

1. **Prose and schemas** are normative, written in RFC 2119 terms. Implementations read these.
2. **The Lean model** states the semantics precisely and proves its invariants. It is executable, so it also generates the conformance vectors.
3. **The conformance kit** judges any implementation from the outside, by its manifest and its wire behaviour. An implementation written by hand, by a coding agent, or from the reference library is conforming when it passes.

Effect and XState implement the patterns AcidCat relies on. They belong to the reference implementation, not the specification.
