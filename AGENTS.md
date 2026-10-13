# Agent instructions

This repository contains the AcidCat specification and its packages. Read [README.md](README.md), [spec/README.md](spec/README.md) and [packages/README.md](packages/README.md) first.

If `.local/AGENTS.md` exists, read it too. The `.local/` directory contains private notes. It is not part of the repository. Never copy its contents, or the names in it, into a tracked file.

## Principles

- **One catalog, many targets.** The catalog is the contract. Each surface comes from it through a binding. The catalog is checked at build time. Implementations do not read it at run time.
- **Simple and permissive.** Require only what clients must rely on. Recommend the rest.
- **Serve each kind of user fully.** When users want different things, give each group a complete package in their own style. Do not make one package that is a compromise. For example: one core in Effect, and one core in plain TypeScript.
- **Precise vocabulary.** Use the terms in [spec/README.md](spec/README.md#vocabulary) with exactly those meanings. Add a term there before you use it.
- **Clear names.** Each package has the name `acid-cat`, `@acid-cat/…` or `acid-cat-…`. The name tells what the package is.
- **One canonical form.** All tools and libraries write a catalog in [canonical form](spec/catalog.md#canonical-form). A change to this form changes all catalog libraries, the Pkl module, the command line and the test files in the same commit.

## Writing style

- The repository is standalone. Write each document so that a new reader understands it without other context.
- Describe what is true now. Do not write history, changes, or plans for a person ("now", "no longer", "the user decided"). Put plans in a "Roadmap" section.
- Use Simplified Technical English (ASD-STE100): short sentences, one topic in each sentence, active voice, simple words, and the same word for the same thing.
- Use RFC 2119 words only for requirements.
- Keep library names (Effect, XState, Vue) out of the core specification. They can be in bindings and in packages.

## Plan

1. Add `acid-cat conform` to `packages/cli`: a test catalog, tests for each binding, and property-based tests for the guarantees in `spec/invocation.md`. Both cores must pass it.
2. Add a site, as its own Moon project.

When a design decision is made for something that does not exist yet, build it. Do not only record it. At the end of each piece of work, tell what was asked and is not done, and why.

## Rules

- Each package is a Moon project with a `test` task. List it in `.moon/workspace.yml`. Add each TypeScript package to `pnpm-workspace.yaml`.
- Each Node dependency comes from the `catalog:` in `pnpm-workspace.yaml`. Never put a version in a `package.json`.
- proto installs the tools (`.prototools`). Moon runs the operations.
- After a change to `packages/`, `schemas/` or `examples/`, run `moon run examples`, then `moon run verify`. Commit the JSON files that change.
- Commits have no AI attribution. Push only when the user asks.
