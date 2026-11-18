import { parser } from "@conventional-commits/parser";

export type ParseProblem = {
  readonly line: number;
  readonly column: number;
  readonly text: string;
  readonly reason: string;
};

const CONVENTIONAL_START = /\r?\n\r?\n(?=(?:feat|fix|docs|style|refactor|perf|test|build|ci|chore|revert)(?:\(.*?\))?: )/;

// release-please 17.6.0 (`build/src/commit.js`) reads a BEGIN_COMMIT_OVERRIDE block from the body of the pull request
// in place of the commit message.
function overrideOrMessage(message: string, pullRequestBody: string): string {
  const override = (pullRequestBody.split("BEGIN_COMMIT_OVERRIDE")[1] ?? "").split("END_COMMIT_OVERRIDE")[0]?.trim() ?? "";
  return override === "" ? message : override;
}

// release-please 17.6.0 splits one commit message into the messages that it parses one at a time.
function splitMessages(message: string): string[] {
  const parts = message.split("BEGIN_NESTED_COMMIT");
  let main = parts.shift() ?? "";
  const nested: string[] = [];
  for (const part of parts) {
    const [newMessage = "", ...rest] = part.split("END_NESTED_COMMIT");
    nested.push(newMessage);
    main += rest.join("END_NESTED_COMMIT");
  }
  return [...main.split(CONVENTIONAL_START).filter(Boolean), ...nested];
}

const POSITION = / at (\d+):(\d+)/;

function problemIn(text: string, source: string, error: unknown): ParseProblem {
  const reason = error instanceof Error ? error.message : String(error);
  const position = POSITION.exec(reason);
  const partLine = Number(position?.[1] ?? 1);
  const column = Number(position?.[2] ?? 1);
  const offset = source.indexOf(text);
  const linesBefore = offset < 0 ? 0 : source.slice(0, offset).split("\n").length - 1;
  return {
    line: linesBefore + partLine,
    column,
    text: text.split(/\r?\n/)[partLine - 1] ?? "",
    reason,
  };
}

export function commitMessageProblems(message: string, pullRequestBody: string = message): ParseProblem[] {
  const source = overrideOrMessage(message, pullRequestBody);
  const problems: ParseProblem[] = [];
  for (const part of splitMessages(source)) {
    try {
      parser(part);
    } catch (error) {
      problems.push(problemIn(part, source, error));
    }
  }
  return problems;
}
