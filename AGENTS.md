# Agent instructions

This repository contains the AcidCat specification and its packages. Read [README.md](README.md), [spec/README.md](spec/README.md) and [packages/README.md](packages/README.md) first.

If `.local/AGENTS.md` exists, read it too. The `.local/` directory contains private notes. It is not part of the repository. Never copy its contents, or the names in it, into a tracked file.

## Principles

- **One catalog, many targets.** The catalog is the contract. Each surface comes from it through a binding. The catalog is checked at build time. Implementations do not read it at run time.
- **Language-neutral.** The specification does not depend on a language. The TypeScript packages are a reference implementation, not the product. Describe them as one implementation among possible others. A core in another language follows the specification and passes `acid-cat conform`.
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

1. Add a site, as its own Moon project.

Both cores MUST pass `acid-cat conform`. Each core runs it in its tests.

When a design decision is made for something that does not exist yet, build it. Do not only record it. At the end of each piece of work, tell what was asked and is not done, and why.

## Rules

- Each package is a Moon project with a `test` task. List it in `.moon/workspace.yml`. Add each TypeScript package to `pnpm-workspace.yaml`.
- Each Node dependency comes from the `catalog:` in `pnpm-workspace.yaml`. Never put a version in a `package.json`.
- proto installs the tools (`.prototools`). Moon runs the operations.
- spec-ts holds only the data and pure functions of the specification. Runtime code, such as servers and I/O, goes in the cores.
- After a change to `packages/`, `schemas/` or `examples/`, run `moon run examples`, then `moon run verify`. Commit the JSON files that change.
- Never write or change a catalog (`*.acidcat.json`) by hand. Change its source, a Pkl module or the code that writes it, and write the JSON again. Only the test inputs of the tools that read JSON catalogs, for example the catalogs that `acid-cat check` must reject, are JSON files that a person writes.
- TypeScript passes `moon run lint`: no type assertions (only `as const`), no non-null assertions, no `any`, no `@ts-ignore`, and `@ts-expect-error` only for a negative type test. Never turn a check off: do not add `oxlint-disable` comments, and do not change `.oxlintrc.json` or `tsconfig.base.json` to make code pass. Check data that is not trusted at run time, and make the types flow from it. A type guard checks at run time everything that its type claims.
- Commits have no AI attribution.
- Each published package has the license file of the repository, and a task in `moon run verify` that builds or packages it the way that its registry receives it.
- Release by merging the release pull request of release-please. Do not change a version or a `CHANGELOG.md` by hand. See [Publishing](packages/README.md#publishing).

## Branches and pull requests

- Never work directly on `main`. GitHub blocks pushes to `main`. Changes go in through a pull request that is merged with a squash merge.
- Each issue or task gets its own branch and its own worktree in `.worktrees/<branch>`. Create it from `main` with `git worktree add .worktrees/<branch> -b <branch> main`, and do all the work in that worktree. Keep the main worktree as you found it.
- When you start a subagent, tell it which branch and worktree it uses: the parent's, or a new one that you name. The subagent does not choose.
- Commit titles and pull request titles are semantic: `type(scope): subject`, for example `fix(catalog): reject duplicate ids`. The types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore` and `revert`. The scope is required. Add `!` after the scope for a breaking change. The `semantic` check (`scripts/check-semantic.sh`) enforces this. The pull request title becomes the commit on `main`.
- Push the branch and open a pull request against `main` with `gh pr create --base main --head <branch>`. A pull request that closes an issue says `Closes #<number>` in its body.
- When a change is too large for one pull request, use `gh stack` (see `.agents/skills/gh-stack`): one branch and one pull request for each layer, in one worktree. Use it when the work splits into layers that a reviewer can read one at a time.
- A human reviews each pull request. Hand off the pull request URL. Merge only after the human accepts the work, or when the human explicitly says to merge without review.
- Each session owns its own branch. Do not push to, rebase or merge a branch that another session owns.
- The session that merges a branch makes CI pass on it. Rebase on `main`, fix what fails, and merge only when every required check is green. Never skip or weaken a check to make it pass.
- After the merge, remove the worktree with `git worktree remove .worktrees/<branch>`.
