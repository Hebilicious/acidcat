# Agent instructions

This repository contains the AcidCat specification and its packages. Read [README.md](README.md), [spec/README.md](spec/README.md) and [packages/README.md](packages/README.md) first.

The `.local/` directory contains private notes. It is not part of the repository. Never copy its contents, or the names in it, into a tracked file.

## Principles

- **One catalog, many targets.** The catalog is the contract. Each surface comes from it through a binding. The catalog is checked at build time. Implementations do not read it at run time.
- **Language-neutral.** The specification does not depend on a language. The TypeScript packages are a reference implementation, not the product. Describe them as one implementation among possible others. A core in another language follows the specification and passes `acid-cat conform`.
- **Simple and permissive.** Require only what clients must rely on. Recommend the rest.
- **No drift between cores.** Each core has the same features, in its own style. A change that adds or changes a feature of one core changes every core in the same pull request or stack, with tests and with the example of each core. A request for one core is a request for every core. Never propose, plan or leave a feature in one core only, and never ask whether the other cores need it.
- **Serve each kind of user fully.** When users want different things, give each group a complete package in their own style. Do not make one package that is a compromise. For example: one core in Effect, and one core in plain TypeScript.
- **Precise vocabulary.** Use the terms in [spec/README.md](spec/README.md#vocabulary) with exactly those meanings. Add a term there before you use it.
- **Clear names.** Each package has the name `acid-cat`, `@acid-cat/…` or `acid-cat-…`. The name tells what the package is.
- **One canonical form.** All tools and libraries write a catalog in [canonical form](spec/catalog.md#canonical-form). A change to this form changes all catalog libraries, the Pkl module, the command line and the test files in the same commit.

## Writing style

- The repository is standalone. Write each document so that a new reader understands it without other context.
- Describe what is true now. Do not write history, changes, or plans for a person ("now", "no longer", "the user decided"). Put plans in a "Roadmap" section.
- Use Simplified Technical English (ASD-STE100): short sentences, one topic in each sentence, active voice, simple words, and the same word for the same thing.
- Use RFC 2119 words only for requirements.
- Do not write "we", "our" or "us". Address the reader, or tell what is true: "Use Pkl", not "We recommend Pkl".
- Keep library names (Effect, XState, Vue) out of the core specification. They can be in bindings and in packages.

## Plan

1. Add a site, as its own Moon project.

Each core MUST pass `acid-cat conform`. Each core runs it in its tests.

When a design decision is made for something that does not exist yet, build it. Do not only record it. At the end of each piece of work, tell what was asked and is not done, and why.

## Rules

- Each package is a Moon project with a `test` task. List it in `.moon/workspace.yml`. Add each TypeScript package to `pnpm-workspace.yaml`.
- Each Node dependency comes from the `catalog:` in `pnpm-workspace.yaml`. Never put a version in a `package.json`.
- proto installs the tools (`.prototools`). Moon runs the operations.
- spec-ts holds only the data and pure functions of the specification. Runtime code, such as servers and I/O, goes in the cores.
- After a change to `packages/`, `schemas/` or `examples/`, run `moon run examples`, then `moon run verify`. Commit the JSON files that change.
- Prefer a source for each catalog (`*.acidcat.json`): a Pkl module, or the code that writes it. When a catalog has a source, never change its JSON by hand: change the source, and write the JSON again. Write JSON by hand only when there is a reason, for example the test inputs of the tools that read JSON catalogs, such as the catalogs that `acid-cat check` must reject.
- TypeScript passes `moon run lint`: no type assertions (only `as const`), no non-null assertions, no `any`, no `@ts-ignore`, and `@ts-expect-error` only for a negative type test. Never turn a check off: do not add `oxlint-disable` comments, and do not change `.oxlintrc.json` or `tsconfig.base.json` to make code pass. Check data that is not trusted at run time, and make the types flow from it. A type guard checks at run time everything that its type claims.
- Write a comment only for what the code cannot say, such as the behavior of a runtime or a protocol. Before review, run [`no-comments`](.agents/skills/no-comments/SKILL.md) on the change.
- A capability description says what it does, and an event description says what happens and when, in one sentence. It does not repeat the audience, the schemas or the failures.
- Test the new behavior once in each core and once in each API of the examples. Do not add a test for a path that an existing test already covers.
- Fix the cause of a problem, not its symptom.
- Commits have no AI attribution.
- Each published package has the license file of the repository, and a task in `moon run verify` that builds or packages it the way that its registry receives it.
- A feature reaches every surface of the examples: each API in `examples/` uses it, with a test. Do not list a surface as not done because no one named it.
- The skill [`skills/acid-cat`](skills/acid-cat/SKILL.md) tells agents how to build with AcidCat. When a change adds or changes a rule of the catalog, a core, a binding or a command of `acid-cat`, change the skill in the same pull request. `gh skill publish --dry-run .` validates it.
- Release by merging the release pull request of release-please. Do not change a version or a `CHANGELOG.md` by hand. See [Publishing](packages/README.md#publishing).

## Verification

Verify each change against what it must do. Do not hunt for edge cases until a reviewer finds nothing: a new reviewer always finds a new edge case, and each fix adds code that the next reviewer attacks.

1. **Acceptance checks first.** Before you write code, write down what done means as checks that run: conform checks, tests, or commands with the output that they must give. Each check comes from what the user asked for, or from a rule of the specification.
2. **Design before code.** For a change that crosses a function boundary or more than one core, sketch at least two designs that differ in their shape, not in details. Choose the design that each core can serve in its own style with the least code. A design that makes a core fight its own library is the wrong design.
3. **Verify against the checks.** An agent that did not write the code runs the change as a user would, on the parent commit and on the head, and gives `PASS`, `PASS+NOTES` or `FAIL` for each check. Green CI is not a verdict.
4. **One adversarial pass.** Give the diff, the specification and what the user asked for to a panel of two or three different models, in parallel and one time. Each reviewer tries to break the change. A finding has the command that it ran, the output, and how that output breaks what the user asked for. Leave out style, and risks that need a future change. When two models find the same failure, it is likely real.
5. **Triage each finding.** Fix it, or dismiss it with a reason. Dismiss a finding that needs an unusual setup that no user is likely to have. A finding that needs a new rule in the specification must name the client that relies on that rule ("Simple and permissive"). Then check only the diff of the fixes, one time.
6. **Attack the premise.** When two fixes rest on the same premise, stop. Write the premise down, and test it before you write another fix. Often the design is wrong, not the code.
7. **Encode what repeats.** When the same manual step or the same fix comes back, make a script, a test, a lint rule or a Moon task do it.
8. **Hand off** the pull request with the result of each check, each finding, and what you fixed or dismissed, and why.

Give each round of work to a new subagent, with the full scope in its brief: what the user asked for, the acceptance checks, the earlier findings, and the branch. Do not add work to a subagent that already returned.

| Role | Model |
| --- | --- |
| Adversarial panel | Codex `gpt-6.1-sol` with reasoning `high`, and Claude Opus 5.5, through `delegate_task` |
| Implementer | Claude Opus 5.5 with medium effort: the `opus-medium` agent |
| Verifier | A model that did not write the code |

## Branches and pull requests

- Never work directly on `main`. GitHub blocks pushes to `main`. Changes go in through a pull request that is merged with a squash merge.
- Each issue or task gets its own branch and its own worktree in `.worktrees/<branch>`. Create it from `main` with `git worktree add .worktrees/<branch> -b <branch> main`, and do all the work in that worktree. Keep the main worktree as you found it.
- When you start a subagent, tell it which branch and worktree it uses: the parent's, or a new one that you name. The subagent does not choose.
- Commit titles and pull request titles are semantic: `type(scope): subject`, for example `fix(catalog): reject duplicate ids`. The types are `feat`, `fix`, `docs`, `style`, `refactor`, `perf`, `test`, `build`, `ci`, `chore` and `revert`. The scope is required. Add `!` after the scope for a breaking change. The `semantic` check (`scripts/check-semantic.sh`) enforces this. The pull request title becomes the commit on `main`.
- Push the branch and open a pull request against `main` with `gh pr create --base main --head <branch>`. A pull request that closes an issue says `Closes #<number>` in its body.
- When a change is too large for one pull request, use `gh stack` (see `.agents/skills/gh-stack`): one branch and one pull request for each layer, in one worktree. Use it when the work splits into layers that a reviewer can read one at a time.
- Before you hand off a pull request, verify it as [Verification](#verification) tells.
- A human reviews each pull request. Hand off the pull request URL. Merge only after the human accepts the work, or when the human explicitly says to merge without review.
- Each session owns its own branch. Do not push to, rebase or merge a branch that another session owns.
- The session that merges a branch makes CI pass on it. Rebase on `main`, fix what fails, and merge only when every required check is green. Never skip or weaken a check to make it pass.
- "Merge" means the work is on `main` both locally and on `origin`: merge the pull request and pull `main`. It is one step: never stop halfway, and never ask whether to do the second half. `main` and `origin/main` are always the same commit: check before reporting a merge as done, and if you find them apart, pull.
- After the merge, remove the worktree with `git worktree remove .worktrees/<branch>`.
