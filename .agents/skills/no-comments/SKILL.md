---
name: no-comments
description: "Delete comments that code can say instead, keep the few that explain what this repository cannot change, and fix what the deleted ones excused. Use before review, when asked to remove or audit comments, or when a sweep over a directory or the repository is asked for."
---

# No comments

Adapted from poteto's pstack `no-comments` skill. Spawn Comment Sicko, then act on
what it reports. Defer to its fresh perspective: it has not read the code with
the comments' author, so it is not persuaded by them.

A comment narrates code, goes stale the first time the code changes without it,
and buries the comment that matters. The few worth keeping explain something no
rename or reshape could: a runtime quirk, a protocol rule, a vendor behavior.
Those stay, and stand out because nothing else is beside them.

## Scope

Use the caller's files or diff. Otherwise use the change set of the task:
`git diff $(git merge-base HEAD main)` plus `git ls-files --others --exclude-standard`.

Generated files are never in scope: every `*.acidcat.json`,
`examples/aircon/apis/schema.graphql`, lock files, `node_modules`, `target/` and
`dist/`. Markdown is prose, not comments, and the [writing style](../../../AGENTS.md#writing-style)
governs it.

A file whose comments are content is never in scope either, because its comments
end up in something else: a template or scaffold, any file a skill or doc tells
an agent to copy (search `skills/` and the docs for "copy"), and any file whose
comment text a tool copies into its output or renders. Reading a file to parse
or analyse its code does not count. These comments are instructions to whoever
fills in or reads the copy, which has no `SKILL.md` beside it.

## Steps

1. Spawn one subagent on the branch and worktree of the task, named as such in
   its prompt. Its prompt is [`references/comment-sicko.md`](references/comment-sicko.md)
   verbatim, then the scope. For a scope over a few hundred comment lines, split
   it by directory into disjoint file sets and spawn one subagent per set in
   parallel, each with the same prompt and its own set.
2. Inspect each report and `git diff`. Reject:
   - edits to anything but comments,
   - files outside the scope,
   - a deleted comment the keep-list protects,
   - a `MUST KILL` flag whose reason misstates the code,
   - a flag that treats deliberate code as guilty.
   A reshape flag on a surprise in this repository's code stays actionable, and
   its comment stays deleted. A keep survives only when it meets a keep-list
   clause; one kept for foreign behavior must name the runtime, vendor or
   protocol behavior it is about. Before accepting a thin `IMPORTANT` or
   `do not remove` kill or keep, read the symbol's callers and its history
   (`git log -S '<symbol>'`). An ambiguous kill stays deleted; a refuted or still
   ambiguous keep is deleted. Revert and rerun a rejected report once with the
   failure named. A second rejection is reported open and fails this skill.
3. Prove that only comments changed: read the diff, run `cargo fmt` in each
   touched Rust crate and `gofmt -l` on touched Go files, then `moon run lint`
   and `moon run verify`. A whitespace-only reflow from a formatter is expected;
   any other code change is a rejected report.
4. A sweep deletes comments and nothing else: a scope of whole directories or the
   repository, or one asked for as a sweep. It ships alone, and its accepted
   `MUST KILL` flags go into a branch stacked above it, one concern for each
   layer, never into the pull request of the sweep. After the sweep, audit every
   deleted comment with [`references/audit.md`](references/audit.md), one
   subagent per file set: its Restore findings go into the sweep; its Encode and
   Design findings go where the flags go.
   For the change set of a task, fix each trivial accepted `MUST KILL` directly:
   delete a dead path, drop a parameter, use the real API, rename the symbol so
   the deleted comment is unnecessary. When a fix needs a new shape, sketch it
   once for the accepted set, then implement the root-cause fix in scope and
   remove every workaround it names. When the root cause is outside the scope,
   land the in-scope part and fix the rest in a branch of its own. A fix to code
   is implementation work, and it gets the review that `AGENTS.md` requires.
5. A constraint comment (`do not remove`, `keep this wording`) that is not about
   something this repository cannot change gets encoded, then deleted; in a
   sweep it is deleted and its encoding goes where step 4 sends the flags. The
   encoding is the cheapest in-scope type, runtime check, test, or lint rule that
   holds the constraint on every run. Offer the encoding and wait for approval
   when a human is present; unattended, encode only what the caller
   pre-approved. Without an encoding, delete the comment and report the
   constraint open.
6. Report the deletion count, restored comments, reruns, the design sketch,
   fixes, encodings, unenforced constraints, and other open work.
