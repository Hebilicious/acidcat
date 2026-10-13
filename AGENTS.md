# Agent instructions

This repository is the AcidCat specification and the packages built around it: one language-neutral catalog per application, checked at build time and served to many targets through bindings. Read [README.md](README.md), [spec/README.md](spec/README.md) (including its vocabulary) and [packages/README.md](packages/README.md) before doing anything else.

## Where things stand

- The repository is local only. It has no remote. Creating one, publishing packages, or publishing a site is the user's decision.
- Draft 0.1 is written: the core (`spec/catalog.md`, `spec/invocation.md`), six bindings, two extensions, conformance, adoption, and the schemas.
- `packages/` holds the command line (`@acid-cat/cli`, the `acid-cat` command) and the catalog libraries for TypeScript, Python, Go, Rust and Pkl. They all produce the same canonical bytes. Every package is published under the name `acid-cat`. Nothing is published yet.
- Jarette's Box (JB) and heb-stack (HS) are the first implementations. [spec/adoption.md](spec/adoption.md) says how each one adopts the specification. JB's real catalog conforms, using the exporter in `adoption/jarettes-box/`.
- There is one reference implementation, `@acid-cat/core`, which is planned: plain TypeScript, following HS's kernel. `@acid-cat/effect` will let Effect users, JB and HS among them, define capabilities for it ([packages/README.md](packages/README.md)). Other languages implement the specification and prove it with `acid-cat conform`.
- There is no formal model. The guarantees worth checking become property-based tests in `acid-cat conform`.

## Principles

- **One catalog, many targets.** The catalog is the contract, and every surface is derived from it by a binding. The catalog is checked at build time, and implementations never need to read it at runtime.
- **Simple and permissive.** Require only what clients must be able to rely on, and recommend the rest. A small, versatile specification is more likely to be adopted than a strict one.
- **Adoptable.** Every change must leave a clean path for JB and HS. When a change affects them, update [spec/adoption.md](spec/adoption.md) in the same commit, and check JB's exported catalog against it.
- **Precise vocabulary.** Use the terms that [spec/README.md](spec/README.md#vocabulary) defines, with exactly those meanings. Add a term there before using it anywhere else.
- **Name packages after what they do.** Every package is published as `acid-cat`, `@acid-cat/…` or `acid-cat-…`, and its name says what it is: the command line, a catalog library, the core, or the Effect integration (see [packages/README.md](packages/README.md)).
- **One canonical text.** Every tool and library writes a catalog in [canonical form](spec/catalog.md#canonical-form). A change to that form changes every catalog library, the Pkl module, the toolchain and the fixtures in the same commit.

## Plan

1. **Add `acid-cat conform`** to `packages/cli`: a fixture catalog, checks for each binding, and property-based tests for the guarantees in `spec/invocation.md`.
2. **Build `@acid-cat/core` and `@acid-cat/effect`** as `packages/core` and `packages/effect`, as [packages/README.md](packages/README.md) describes. HS, then JB, must pass `acid-cat conform` before switching to them.
3. **Build the site** last, as its own Moon project.

## Rules

- Prose is normative and uses RFC 2119 words only where a requirement is meant.
- Keep library names (Effect, XState, Vue) out of the core specification. They belong in bindings, in `@acid-cat/effect`, and in [spec/adoption.md](spec/adoption.md).
- One statement of each rule. Bindings and schemas refer to the core text and do not repeat it.
- Every package is a Moon project with a `test` task, listed in `.moon/workspace.yml`. TypeScript packages also join `pnpm-workspace.yaml`.
- After changing `packages/`, `schemas/` or `examples/`, run `moon run examples` and then `moon run verify`, and commit the rendered JSON.
- Never modify `~/GitHub/jarettes-box` or `~/GitHub/heb-stack` from here. Read them with `git show <ref>:<path>` at the refs that `history/divergence.md` pins. To run JB's code, export a snapshot with `git archive` into `/tmp`.
- Toolchains go through proto (`.prototools`) and operations through Moon tasks, as in heb-stack.
- Commits carry no AI attribution. Push only when the user asks.
