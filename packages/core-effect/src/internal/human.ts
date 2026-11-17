import { Predicate } from "effect";

import {
  AGENT_VARIABLES,
  AND_WORD,
  CI_VARIABLE,
  FALSE_VALUES,
  FORM_NAMES,
  INVALID_INPUT_EXIT_CODE,
  LIST_SEPARATOR,
  MESSAGES,
  NAME_SEPARATOR,
  OR_WORD,
  TRIM_CHARACTERS,
  VALUE_SEPARATOR,
} from "./output.generated.ts";

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

/**
 * A flag that chooses the form of the output. Each name is `--word` or `-x`, with one letter or digit. A switch gives
 * `form`, for example `--json`. A flag with a value gives `values`, a map from each value to a form, for example
 * `--format <text|json>` with `{ text: "human", json: "json" }`. It takes `--format text`, `--format=text` and `-f text`.
 */
export type OutputFlag =
  | { readonly names: readonly string[]; readonly form: Form; readonly values?: undefined }
  | { readonly names: readonly string[]; readonly values: { readonly [value: string]: Form }; readonly form?: undefined };

const LONG_NAME = /^--[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const SHORT_NAME = /^-[A-Za-z0-9]$/;

export function outputErrors(flags: readonly OutputFlag[], otherFlags: ReadonlyMap<string, string>): readonly string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const flag of flags) {
    const [first] = flag.names;
    if (first === undefined) errors.push(MESSAGES.noName);
    for (const name of flag.names) {
      if (!LONG_NAME.test(name) && !SHORT_NAME.test(name)) {
        errors.push(filled(MESSAGES.badName, { name }));
        continue;
      }
      if (seen.has(name)) errors.push(filled(MESSAGES.sameAsOutputFlag, { name }));
      seen.add(name);
      const other = otherFlags.get(name);
      if (other !== undefined) errors.push(filled(MESSAGES.sameAsOther, { name, other }));
    }
    if (first !== undefined && flag.values !== undefined && Object.keys(flag.values).length === 0) errors.push(filled(MESSAGES.noValues, { name: first }));
  }
  return errors;
}

export const filled = (template: string, parts: { readonly [name: string]: string }): string =>
  template.replaceAll(/\{(\w+)\}/g, (placeholder, name: string) => parts[name] ?? placeholder);

const joined = (values: readonly string[], word: string): string =>
  values.length < 2 ? values.join("") : `${values.slice(0, -1).join(LIST_SEPARATOR)} ${word} ${values.at(-1) ?? ""}`;

const codePoints = (text: string): number[] => Array.from(text, (character) => character.codePointAt(0) ?? 0);

const byCodePoint = (left: string, right: string): number => {
  const others = codePoints(right);
  for (const [index, code] of codePoints(left).entries()) {
    const other = others[index];
    if (other === undefined) return 1;
    if (code !== other) return code - other;
  }
  return codePoints(left).length - others.length;
};

const sortedValues = (values: { readonly [value: string]: Form }): readonly (readonly [string, Form])[] =>
  Object.entries(values).sort(([left], [right]) => byCodePoint(left, right));

export function outputFlagHelp(flag: OutputFlag): string {
  const names = flag.names.join(NAME_SEPARATOR);
  if (flag.values === undefined) return filled(MESSAGES.switchHelp, { names, form: FORM_NAMES[flag.form] });
  const values = sortedValues(flag.values);
  const meanings = values.map(([value, form]) => filled(MESSAGES.meaning, { value, form: FORM_NAMES[form] }));
  return filled(MESSAGES.valuesHelp, { names, values: values.map(([value]) => value).join(VALUE_SEPARATOR), meanings: joined(meanings, AND_WORD) });
}

export type OutputChoice = { readonly form: Form | undefined; readonly args: readonly string[]; readonly error?: undefined } | { readonly error: string };

export function outputChoice(flags: readonly OutputFlag[], args: readonly string[], commandNames: readonly string[]): OutputChoice {
  const rest: string[] = [];
  let form: Form | undefined;
  const items = args.values();
  for (const arg of items) {
    if (arg === "--" || (rest.length === 0 && commandNames.includes(arg))) {
      rest.push(arg, ...items);
      break;
    }
    const [name = arg, inline] = arg.startsWith("--") ? arg.split(/=(.*)/s, 2) : [arg];
    const flag = flags.find(({ names }) => names.includes(name));
    if (flag === undefined || (flag.values === undefined && inline !== undefined)) {
      rest.push(arg);
      continue;
    }
    if (flag.values === undefined) {
      form = flag.form;
      continue;
    }
    const value = inline ?? items.next().value;
    const chosen = value === undefined || !Object.hasOwn(flag.values, value) ? undefined : flag.values[value];
    if (chosen === undefined) return { error: filled(MESSAGES.badValue, { name, values: joined(sortedValues(flag.values).map(([each]) => each), OR_WORD) }) };
    form = chosen;
  }
  return { form, args: rest };
}

export type OutputRun = { readonly form: Form; readonly args: readonly string[]; readonly exitCode?: undefined } | { readonly exitCode: number; readonly error: string };

export const outputRun = (
  flags: readonly OutputFlag[],
  args: readonly string[],
  commandNames: readonly string[],
  fallback: "auto" | "json" | undefined,
  auto: () => Form,
): OutputRun => {
  const chosen = outputChoice(flags, args, commandNames);
  if (chosen.error !== undefined) return { exitCode: INVALID_INPUT_EXIT_CODE, error: chosen.error };
  return { form: chosen.form ?? (fallback === "auto" ? auto() : "json"), args: chosen.args };
};

const FALSE_SET: ReadonlySet<string> = new Set(FALSE_VALUES);

const trimmed = (value: string): string => {
  let start = 0;
  let end = value.length;
  while (start < end && TRIM_CHARACTERS.includes(value.charAt(start))) start += 1;
  while (end > start && TRIM_CHARACTERS.includes(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
};

const asciiLowercase = (value: string): string => value.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());

const isTruthy = (value: string | undefined): boolean => value !== undefined && !FALSE_SET.has(asciiLowercase(trimmed(value)));

/**
 * The form that the default `"auto"` of the output gives: human when standard output is a terminal and the environment
 * shows no CI and no coding agent, else JSON.
 */
export const formOf = (stdoutIsTerminal: boolean, environment: Environment): Form =>
  stdoutIsTerminal && !isTruthy(environment[CI_VARIABLE]) && !AGENT_VARIABLES.some((name) => isTruthy(environment[name])) ? "human" : "json";

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
