# Agent instructions

This repository is the AcidCat specification: one language-neutral catalog per application, checked at build time and served to many targets through bindings. Read [README.md](README.md) and [spec/README.md](spec/README.md), including its vocabulary, before doing anything else.

## Where things stand

- The repository is local only. It has no remote. Creating one, or publishing the site, is the user's decision.
- Draft 0.1 is written: the core (`spec/catalog.md`, `spec/invocation.md`), six bindings, two extensions, conformance, adoption, and the schemas.
- The toolchain (`toolchain/`) checks, formats and views catalogs. SDKs for Pkl, TypeScript, Python, Go and Rust (`sdk/`) write them, and all of them produce the same canonical bytes.
- Jarette's Box (JB) and heb-stack (HS) are the first implementations. [spec/adoption.md](spec/adoption.md) says how each one adopts the specification. JB's real catalog conforms, using the exporter in `adoption/jarettes-box/`.
- The reference implementation will start from HS's kernel (see `ref/ts/README.md`).
- There is no formal model. The guarantees worth checking become property-based tests in the conformance kit.
- Moon, Node, pnpm, Pkl, Python, Go and Rust are pinned in `.prototools`.

## Principles

- **One catalog, many targets.** The catalog is the contract, and every surface is derived from it by a binding. The catalog is checked at build time, and implementations never need to read it at runtime.
- **Simple and permissive.** Require only what clients must be able to rely on, and recommend the rest. A small, versatile specification is more likely to be adopted than a strict one.
- **Adoptable.** Every change must leave a clean path for JB and HS. When a change affects them, update [spec/adoption.md](spec/adoption.md) in the same commit, and check JB's exported catalog against it.
- **Precise vocabulary.** Use the terms that [spec/README.md](spec/README.md#vocabulary) defines, with exactly those meanings. Add a term there before using it anywhere else.
- **One canonical text.** Every tool and SDK writes a catalog in [canonical form](spec/catalog.md#canonical-form). A change to that form changes every SDK, the Pkl module, the toolchain and the fixtures in the same commit.

## Plan

1. **Build the conformance kit**, starting with a fixture catalog and property-based tests for the guarantees in `spec/invocation.md`.
2. **Build the TypeScript reference implementation** from HS's kernel, as `ref/ts/README.md` describes. HS, then JB, must pass the kit before switching to it.
3. **Build the site** last.

## Rules

- Prose is normative and uses RFC 2119 words only where a requirement is meant.
- Keep library names (Effect, XState, Vue) out of the core. They belong in bindings, in `ref/ts/`, and in [spec/adoption.md](spec/adoption.md).
- One statement of each rule. Bindings and schemas refer to the core text and do not repeat it.
- After changing `sdk/`, `schemas/`, `toolchain/` or `examples/`, run `moon run examples` and then `moon run verify`, and commit the rendered JSON.
- Never modify `~/GitHub/jarettes-box` or `~/GitHub/heb-stack` from here. Read them with `git show <ref>:<path>` at the refs that `history/divergence.md` pins. To run JB's code, export a snapshot with `git archive` into `/tmp`.
- Toolchains go through proto (`.prototools`) and operations through Moon tasks, as in heb-stack.
- Commits carry no AI attribution. Push only when the user asks.
