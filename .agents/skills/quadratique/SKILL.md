---
name: quadratique
description: Work with Quadratique, the issue tracker of this repository. Use before a session changes any file, when turning a plan or a PRD into issues, when picking, claiming or implementing work, when asking for a review, and after a merge.
---

# Quadratique

Quadratique holds every task of this repository as an issue: what to do, who holds it, on which branch, and how it ended. Run `quadratique` from the worktree where the work happens: it reads the project, the branch and the worktree from there. Answers are JSON: one issue under `issue`, a list under `items`. This skill names the commands of the usual path; `quadratique instructions` lists them all, for a command that is not here.

## Before a session changes anything

The session's work has an issue before any file changes.

1. The issue the human names comes first.
2. Otherwise `quadratique issue list --claim mine`: your session's claims; act on each from any worktree. Read its notes, a reviewer may have sent it back.
3. Otherwise the first of `quadratique ready` that fits the task. When none fits, create one with `quadratique create --title "<the outcome>" --description "<what, why>" --acceptance "<checkable criteria, one per line>"` and tell the human its id.

## From a plan or a PRD to issues

Read [`planning.md`](planning.md) before you turn a plan or a PRD into issues.

## Implementing an issue

1. Create the branch and worktree as `AGENTS.md` says. From inside it: `quadratique claim --issue ABC-12`, which prints the whole issue with its `revision`. On `Held`, take another.
2. Work to the acceptance criteria. Notes for the next person: `quadratique issue update --issue ABC-12 --revision <revision> --notes "..."`; on `Stale`, `quadratique show --issue ABC-12` and write again. Other work you find: check `quadratique issue list --text "words"`, then `quadratique create --title "..." --description "..." --acceptance "..." --origin ABC-12`: it is an issue of its own, with its own branch. When you cannot know the outcome yet, the acceptance says what must be known or decided for the issue to be done.
3. Commit with `Refs: ABC-12` as the last line. A pull request's body carries the same line: a squash merge may keep only that body.
4. `quadratique close --issue ABC-12 --evidence "..."`: per acceptance criterion the command and what it printed, and the commit. The issue is now in review and still yours. Repeat `--issue` to close several at once: the answer lists them under `items`; a refusal is `NotClosed`, which changes none.
5. Ask for the review as `AGENTS.md` says, with the issue, the branch and the evidence.
6. While it waits, you may go on with the next issue on a branch from this one: `quadratique issue link --issue ABC-13 --kind stacked-on --target ABC-12`, then claim ABC-13 from that branch. If ABC-12 goes back to work, keep your claim on ABC-13 and merge ABC-12's new commits into your branch before you go on.

## After the review

- Changes requested: first `quadratique issue update --issue ABC-12 --revision <revision> --status in-progress`, so the board shows you at work. Then change, commit, `close` with the new evidence, and ask again.
- Accepted: merge as `AGENTS.md` says; after a merge on GitHub, `git fetch`. Quadratique sees the merge and moves the issue to `merged`, which gives it a new `revision`. `quadratique show --issue ABC-12` waits up to 2 seconds for the repository: while it still says review, run it again; if it stays there, it waits for an issue it is stacked on to merge (nothing to do), or the commit on the default branch lacks `Refs: ABC-12` or landed before the `close`: tell the human. When the default branch's checks pass, or at once when it has none: `quadratique issue update --issue ABC-12 --revision <revision from that show> --status done`.
- A claim left by an agent that ended: for feedback, add a note; to free it in review, `quadratique release --issue ABC-12 --reason "..."` (any agent may); before review, ask the human.

## Blocked

With a human in the session, ask there. Unattended, create the question as an issue for the human that blocks yours, then `quadratique release --issue ABC-12 --reason "..."`.
