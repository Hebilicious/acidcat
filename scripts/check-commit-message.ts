import { readFileSync } from "node:fs";

import { commitMessageProblems } from "./commit-message.ts";

const message = readFileSync(0, "utf-8");
const problems = commitMessageProblems(message, process.env["PR_BODY"] ?? message);

if (problems.length === 0) {
  console.log("ok:   release-please can parse the squash commit.");
  process.exit(0);
}

for (const problem of problems) {
  console.error(`fail: line ${problem.line}, column ${problem.column}: ${JSON.stringify(problem.reason)}`);
  console.error(`      ${problem.text}`);
}
console.error(`
release-please cannot parse this squash commit, so it skips the commit and releases no package for it.
The squash commit is the pull request title and its body, which GitHub wraps at 72 columns.
The parser reads a line that starts with a word followed by "(" as a footer. It fails when a "(" or the end of
the line comes before the ")". A fenced code block does not help.
Change the body: start that line with another word, or put a space at the start of the line.
Write the override markers only for an override: release-please reads the text after the first marker as the commit.
Or put the commit that release-please must read in the body:

BEGIN_COMMIT_OVERRIDE
fix(scope): subject
END_COMMIT_OVERRIDE`);
process.exit(1);
