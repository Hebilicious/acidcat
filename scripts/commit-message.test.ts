import assert from "node:assert/strict";
import { test } from "node:test";

import { commitMessageProblems } from "./commit-message.ts";

const REJECTED = `fix(catalog): write integers above 2^53 as JSON.stringify writes them (#195)

## Bug

spec/catalog.md#canonical-form says numbers are written as
\`JSON.stringify\` writes them.
\`JSON.stringify(JSON.parse("9007199254740993"))\` is \`9007199254740992\`.
`;

test("a line that the parser reads as a broken footer is a problem at its line and column", () => {
  assert.deepEqual(commitMessageProblems(REJECTED), [
    {
      line: 7,
      column: 27,
      text: '`JSON.stringify(JSON.parse("9007199254740993"))` is `9007199254740992`.',
      reason: "unexpected token '(' at 7:27, valid tokens [)]",
    },
  ]);
});

test("a title with a body that the parser accepts has no problem", () => {
  assert.deepEqual(commitMessageProblems("fix(core-ts): treat a path that is not under base as an unknown route (#198)\n\nThe call `f(g(x))` is fine.\n"), []);
});

test("a BEGIN_COMMIT_OVERRIDE block in the pull request body replaces the message", () => {
  const body = "BEGIN_COMMIT_OVERRIDE\nfix(catalog): write integers above 2^53 as JSON.stringify writes them\nEND_COMMIT_OVERRIDE\n";
  assert.deepEqual(commitMessageProblems(REJECTED, body), []);
});
