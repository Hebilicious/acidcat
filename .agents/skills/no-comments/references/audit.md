# Removed-comment audit

Prove that every comment a sweep deleted left no hole: an agent reading the code
today must still understand what it does and why, at the moment that matters.

For each removed comment (`git diff <base> -- <file>`; the original is
`git show <base>:<file>`):

1. Read the current code where the comment was, without rereading the comment:
   the function, its callers, its types and its tests. Note what an agent would
   infer about its purpose and constraints.
2. Compare that with what the comment said, and classify it:
   - **Redundant**: a name, type or test already says it.
   - **Restore**: it meets the keep-list in
     [`comment-sicko.md`](comment-sicko.md). Restore it, trimmed to the sentence
     that names the foreign behavior or contract.
   - **Encode**: a fact about this repository's code that the code does not
     show, which an agent changing that code would plausibly break. Name the
     code change that would say it (a name, constant, type, assertion or test).
   - **Design**: saying it in code needs a design of its own.
   - A comment the code contradicts is Redundant; report it as a finding.

Judge strictly both ways: a fact an agent recovers in a minute from the
surrounding code is Redundant; a measured constraint no code expresses is not.

Report the counts, then each Restore, Encode and Design item as
`file:line — the fact — the clause, encoding or reason`.
