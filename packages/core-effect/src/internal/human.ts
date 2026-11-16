import { Predicate } from "effect";

export type Form = "human" | "json";

/** The styles and the table that a formatter of the command line gets. Without color, each style gives its text unchanged. */
export interface Ui {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly ok: (text: string) => string;
  readonly warn: (text: string) => string;
  readonly error: (text: string) => string;
  readonly table: (header: readonly string[], rows: readonly (readonly string[])[]) => string;
}

export type Environment = { readonly [name: string]: string | undefined };

const AGENT_VARIABLES = [
  "AI_AGENT",
  "CLAUDECODE",
  "CODEX_THREAD_ID",
  "CURSOR_AGENT",
  "GEMINI_CLI",
  "OPENCODE",
  "AMP_CURRENT_THREAD_ID",
  "AUGMENT_AGENT",
  "QWEN_CODE_SESSION_ID",
  "PI_CODING_AGENT",
  "CRUSH",
  "COPILOT_AGENT",
] as const;

const FALSE_VALUES = new Set(["", "0", "false", "no", "off"]);

const isTruthy = (value: string | undefined): boolean => value !== undefined && !FALSE_VALUES.has(value.trim().toLowerCase());

/**
 * The form of the output when the arguments do not choose one: human when standard output is a terminal and the
 * environment shows no CI and no coding agent, else JSON.
 */
export const formOf = (stdoutIsTerminal: boolean, environment: Environment): Form =>
  stdoutIsTerminal && !isTruthy(environment.CI) && !AGENT_VARIABLES.some((name) => isTruthy(environment[name])) ? "human" : "json";

export const hasColor = (form: Form, stdoutIsTerminal: boolean, environment: Environment): boolean =>
  form === "human" && stdoutIsTerminal && (environment.NO_COLOR ?? "") === "";

const style = (color: boolean, open: number, close: number) => (text: string) => (color ? `\u001b[${open}m${text}\u001b[${close}m` : text);

export const ui = (color: boolean): Ui => ({
  bold: style(color, 1, 22),
  dim: style(color, 2, 22),
  ok: style(color, 32, 39),
  warn: style(color, 33, 39),
  error: style(color, 31, 39),
  table,
});

export function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...lines.map((line) => (line[column] ?? "").length)));
  return lines.map((line) => widths.map((width, column) => (line[column] ?? "").padEnd(width)).join("  ").trimEnd()).join("\n");
}

type Scalar = string | number | boolean | null;

const isScalar = (value: unknown): value is Scalar =>
  value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const isScalars = (value: unknown): value is readonly Scalar[] => Array.isArray(value) && value.every(isScalar);

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } => Predicate.isReadonlyObject(value) && !Array.isArray(value);

const isOneLine = (value: unknown): boolean => isScalar(value) || isScalars(value);

const indent = (text: string, first: string, rest: string): string =>
  text
    .split("\n")
    .map((line, index) => `${index === 0 ? first : rest}${line}`)
    .join("\n");

/** The generic layout of a JSON value for a person. `null` at the top level gives an empty string: no output. */
export const layout = (value: unknown): string => (value === null ? "" : trimLines(layoutOf(value)));

const trimLines = (text: string): string =>
  text
    .split("\n")
    .map((line) => line.trimEnd())
    .join("\n")
    .trimEnd();

function layoutOf(value: unknown): string {
  if (value === null) return "null";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return JSON.stringify(value);
  if (Array.isArray(value)) return arrayLayout(value);
  if (isRecord(value)) return objectLayout(value);
  return "null";
}

function arrayLayout(items: readonly unknown[]): string {
  if (items.length === 0) return "(none)";
  if (isScalars(items)) return items.map(layoutOf).join(", ");
  const records = items.filter(isRecord);
  if (records.length === items.length && records.every((record) => Object.values(record).every(isOneLine))) {
    const columns = [...new Set(records.flatMap((record) => Object.keys(record)))];
    return table(
      columns,
      records.map((record) => columns.map((column) => (Object.hasOwn(record, column) ? layoutOf(record[column]) : ""))),
    );
  }
  return items.map((item) => indent(layoutOf(item), "- ", "  ")).join("\n");
}

function objectLayout(record: { readonly [key: string]: unknown }): string {
  const entries = Object.entries(record);
  if (entries.length === 0) return "(empty)";
  const width = Math.max(0, ...entries.flatMap(([key, member]) => (isOneLine(member) ? [key.length] : [])));
  return entries
    .map(([key, member]) => (isOneLine(member) ? `${key.padEnd(width)}  ${layoutOf(member)}` : `${key}:\n${indent(layoutOf(member), "  ", "  ")}`))
    .join("\n");
}
