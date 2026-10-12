# Agent instructions

This repository is the AcidCat specification: one language-neutral catalog per application, served to many targets through bindings. Read [README.md](README.md) and [spec/README.md](spec/README.md), including its vocabulary, before doing anything else.

## Where things stand

- The repository is local only. It has no remote. Creating one, or publishing the site, is the user's decision.
- Draft 0.1 is written: the core (`spec/catalog.md`, `spec/invocation.md`), six bindings, two extensions, conformance, adoption, and the schemas in `schemas/`. `examples/aircon.pkl` renders to `examples/aircon.acidcat.json`, which `moon run check` validates. Catalogs are written in Pkl (`sdk/pkl/Catalog.pkl`) or with the TypeScript, Python, Go and Rust SDKs in `sdk/`, which all reproduce the air-conditioner catalog.
- The divergence inventory is closed. It is now a record of how the decisions were reached.
- Jarette's Box (JB) and heb-stack (HS) are the first implementations. [spec/adoption.md](spec/adoption.md) says how each one moves onto the specification.
- Moon, Node, pnpm, Pkl, Python, Go and Rust are pinned in `.prototools`. Lean is not pinned yet.

## Principles

- **One catalog, many targets.** The catalog is the contract, and every surface is derived from it by a binding. The catalog is checked at build time; implementations never need to read it at runtime. Anything specific to a language or a protocol belongs in a binding, never in the core.
- **Simple and permissive.** Require only what clients must be able to rely on, and recommend the rest. A small, versatile specification is more likely to be adopted than a strict one.
- **Adoptable.** Every change must leave a clean path for JB and HS. When a change affects them, update [spec/adoption.md](spec/adoption.md) in the same commit.
- **Precise vocabulary.** Use the terms that [spec/README.md](spec/README.md#vocabulary) defines, with exactly those meanings. Add a term there before using it anywhere else.

## Plan

1. **Build the Lean model** (see `lean/README.md`). Pin Lean through proto if a plugin exists; otherwise ask the user how to install it.
2. **Build the conformance kit**, then the TypeScript reference implementation, including a catalog generator for Effect definitions. Both JB and HS must pass the kit before either one switches to the reference implementation.
3. **Build the site** last.

## Rules

- Prose is normative and uses RFC 2119 words only where a requirement is meant.
- Keep library names (Effect, XState, Vue) out of the core. They belong in bindings, in `ref/ts/`, and in [spec/adoption.md](spec/adoption.md).
- One statement of each rule. Bindings and schemas refer to the core text and do not repeat it.
- After changing `sdk/`, `schemas/` or `examples/`, run `moon run examples` and then `moon run verify`, and commit the rendered JSON. A change to the catalog format changes every SDK and `sdk/pkl/Catalog.pkl` in the same commit.
- Never modify `~/GitHub/jarettes-box` or `~/GitHub/heb-stack` from here. Read them with `git show <ref>:<path>` at the refs that `spec/divergence.md` pins.
- Toolchains go through proto (`.prototools`) and operations through Moon tasks, as in heb-stack.
- Commits carry no AI attribution. Push only when the user asks.
