import type { EmptyInput, FailureData, FailureSchemas } from "./app.ts";
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
} from "./cli-output.generated.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

export type CliForm = "human" | "json";

/**
 * A flag that chooses the form of the output. Each name is `--word` or `-x`, with one letter or digit. A switch gives
 * `form`, for example `--json`. A flag with a value gives `values`, a map from each value to a form, for example
 * `--format <text|json>` with `{ text: "human", json: "json" }`. It takes `--format text`, `--format=text` and `-f text`.
 */
export type CliOutputFlag =
  | { readonly names: readonly string[]; readonly form: CliForm; readonly values?: undefined }
  | { readonly names: readonly string[]; readonly values: { readonly [value: string]: CliForm }; readonly form?: undefined };

/**
 * The human form of the output. Without this option, the command line writes JSON only, and takes no output flag.
 */
export interface CliOutput {
  /**
   * The flags that choose the form. They can be anywhere in the arguments. When the arguments give more than one, the
   * last one wins.
   */
  readonly flags?: readonly CliOutputFlag[] | undefined;
  /**
   * The form when the arguments give no output flag. The default is `"json"`. `"auto"` is the human form when standard
   * output is a terminal and no CI and no coding agent is detected, and JSON in all other cases.
   */
  readonly default?: "auto" | "json" | undefined;
  /**
   * The formatters of the human form, made with `cliFormat`. Give one format at most for each capability or event of
   * the target. A value with no formatter has the generic layout.
   */
  readonly formats?: readonly CliFormat[] | undefined;
}

/** The styles and the table that a formatter of the command line gets. Without color, each style gives the text unchanged. */
export interface CliUi {
  readonly bold: (text: string) => string;
  readonly dim: (text: string) => string;
  readonly ok: (text: string) => string;
  readonly warn: (text: string) => string;
  readonly error: (text: string) => string;
  /** A table: the header, then one line for each row. The columns are separated by two spaces and padded to the widest cell. */
  readonly table: (header: readonly string[], rows: readonly (readonly string[])[]) => string;
}

/** Gives the text of a JSON value, or `undefined` when the value does not agree with the schema. */
export type CliRender = (json: unknown, ui: CliUi) => Promise<string | undefined>;

/** The formatters of one capability or one event for the human form of the command line. Make it with `cliFormat`. */
export interface CliFormat {
  readonly member: "capability" | "event";
  readonly id: string;
  /** The formatter of the value of a capability, or of the payload of an event. */
  readonly value?: CliRender | undefined;
  /** The formatter of each failure tag of a capability. */
  readonly failures: ReadonlyMap<string, CliRender>;
}

type Format<Value> = (value: Value, ui: CliUi) => string;

type FailureFormats<Failures> = { readonly [Tag in keyof Failures]?: Format<{ readonly _tag: Tag } & Failures[Tag]> };

interface CapabilityFormats<Value, Failures> {
  readonly value?: Format<Value> | undefined;
  readonly failures?: ([keyof Failures] extends [never] ? never : FailureFormats<Failures>) | undefined;
}

interface Formattable<Value, Failures extends FailureData> {
  readonly id: string;
  readonly run: unknown;
  readonly output?: StandardSchemaV1<unknown, Value> | undefined;
  readonly failures?: FailureSchemas<Failures> | undefined;
}

interface FormattableEvent<Payload> {
  readonly id: string;
  readonly subscribe: unknown;
  readonly payload?: StandardSchemaV1<unknown, Payload> | undefined;
}

/**
 * The formatters of a capability or an event for the human form of the command line. Give them in the option `formats`
 * of the command line. A formatter gets the value decoded from its JSON form with the schema of the capability or the
 * event. If the value does not decode, or the formatter throws, the command line writes the generic layout.
 *
 * ```ts
 * cliFormat(statusGet, { value: (status, ui) => ui.bold(status.mode), failures: { Offline: (_, ui) => ui.error("offline") } });
 * cliFormat(statusGet, (status) => status.mode);
 * cliFormat(statusChanged, (status) => status.mode);
 * ```
 */
export function cliFormat<Value, Failures extends FailureData>(capability: Formattable<Value, Failures>, value: Format<NoInfer<Value>>): CliFormat;
export function cliFormat<Payload>(event: FormattableEvent<Payload>, payload: Format<NoInfer<Payload>>): CliFormat;
export function cliFormat<Value, Failures extends FailureData>(
  capability: Formattable<Value, Failures>,
  formats: CapabilityFormats<NoInfer<Value>, NoInfer<Failures>>,
): CliFormat;
export function cliFormat<Value, Failures extends FailureData>(
  of: Formattable<Value, Failures> | FormattableEvent<Value>,
  formats: Format<Value | EmptyInput> | CapabilityFormats<Value | EmptyInput, Failures>,
): CliFormat {
  const schema = "run" in of ? of.output : of.payload;
  const { value, failures } = typeof formats === "function" ? { value: formats, failures: undefined } : formats;
  const failureRenders = new Map<string, CliRender>();
  if ("run" in of && failures !== undefined) {
    const schemas = of.failures;
    for (const tag of Object.keys(failures)) {
      if (schemas === undefined || !isKeyOf(schemas, tag)) throw new Error(`The capability ${of.id} has no failure ${tag}.`);
      const render = failureRender(tag, schemas[tag], failures[tag]);
      if (render !== undefined) failureRenders.set(tag, render);
    }
  }
  return {
    member: "run" in of ? "capability" : "event",
    id: of.id,
    ...(value === undefined ? {} : { value: schema === undefined ? emptyRender(value) : renderWith(schema, value) }),
    failures: failureRenders,
  };
}

const isKeyOf = <T extends object>(object: T, key: string): key is Extract<keyof T, string> => Object.hasOwn(object, key);

function renderWith<Value>(schema: StandardSchemaV1<unknown, Value>, format: Format<Value>): CliRender {
  return async (json, ui) => {
    const decoded = await schema["~standard"].validate(json);
    return decoded.issues === undefined ? format(decoded.value, ui) : undefined;
  };
}

const emptyRender =
  (format: Format<EmptyInput>): CliRender =>
  async (json, ui) =>
    isRecord(json) && Object.keys(json).length === 0 ? format({}, ui) : undefined;

function failureRender<Failures extends FailureData, Tag extends keyof Failures & string>(
  tag: Tag,
  schema: FailureSchemas<Failures>[Tag],
  format: FailureFormats<Failures>[Tag],
): CliRender | undefined {
  if (format === undefined) return undefined;
  return async (json, ui) => {
    const decoded = await schema["~standard"].validate(json);
    return decoded.issues === undefined ? format({ ...decoded.value, _tag: tag }, ui) : undefined;
  };
}

export function cliFormatErrors(formats: readonly CliFormat[], capabilities: readonly string[], events: readonly string[]): string[] {
  const errors: string[] = [];
  const seen = new Set<string>();
  for (const { member, id } of formats) {
    if (seen.has(id)) errors.push(`Two formats are for ${id}. Give one format for each capability or event.`);
    seen.add(id);
    if (!(member === "capability" ? capabilities : events).includes(id)) errors.push(`A format is for the ${member} ${id}, which is not in the target of the command line.`);
  }
  return errors;
}

function trimmed(value: string): string {
  let start = 0;
  let end = value.length;
  while (start < end && TRIM_CHARACTERS.includes(value.charAt(start))) start += 1;
  while (end > start && TRIM_CHARACTERS.includes(value.charAt(end - 1))) end -= 1;
  return value.slice(start, end);
}

const asciiLowercase = (value: string): string => value.replaceAll(/[A-Z]/g, (letter) => letter.toLowerCase());

const isTruthy = (value: string | undefined): boolean => value !== undefined && !FALSE_VALUES.includes(asciiLowercase(trimmed(value)));

export function defaultCliOutput(isTerminal: boolean, env: { readonly [name: string]: string | undefined }): CliForm {
  if (!isTerminal || isTruthy(env[CI_VARIABLE]) || AGENT_VARIABLES.some((name) => isTruthy(env[name]))) return "json";
  return "human";
}

const LONG_NAME = /^--[a-z][a-z0-9]*(-[a-z0-9]+)*$/;

const SHORT_NAME = /^-[A-Za-z0-9]$/;

export function cliOutputErrors(flags: readonly CliOutputFlag[], otherFlags: ReadonlyMap<string, string>): string[] {
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

function byCodePoint(left: string, right: string): number {
  const others = codePoints(right);
  for (const [index, code] of codePoints(left).entries()) {
    const other = others[index];
    if (other === undefined) return 1;
    if (code !== other) return code - other;
  }
  return codePoints(left).length - others.length;
}

const sortedValues = (values: { readonly [value: string]: CliForm }): readonly (readonly [string, CliForm])[] =>
  Object.entries(values).sort(([left], [right]) => byCodePoint(left, right));

export function cliOutputFlagHelp(flag: CliOutputFlag): string {
  const names = flag.names.join(NAME_SEPARATOR);
  if (flag.values === undefined) return filled(MESSAGES.switchHelp, { names, form: FORM_NAMES[flag.form] });
  const values = sortedValues(flag.values);
  const meanings = values.map(([value, form]) => filled(MESSAGES.meaning, { value, form: FORM_NAMES[form] }));
  return filled(MESSAGES.valuesHelp, { names, values: values.map(([value]) => value).join(VALUE_SEPARATOR), meanings: joined(meanings, AND_WORD) });
}

export type CliOutputChoice = { readonly form?: CliForm | undefined; readonly args: readonly string[]; readonly error?: undefined } | { readonly error: string };

// Package runners, such as `pnpm` and `npx`, pass a `--` before the arguments of the program.
const programArguments = (args: readonly string[]): readonly string[] => (args[0] === "--" ? args.slice(1) : args);

export function cliOutputChoice(flags: readonly CliOutputFlag[], args: readonly string[], commandNames: readonly string[]): CliOutputChoice {
  const rest: string[] = [];
  let form: CliForm | undefined;
  const items = programArguments(args).values();
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

export type CliOutputRun = { readonly form: CliForm; readonly args: readonly string[]; readonly exitCode?: undefined } | { readonly exitCode: number; readonly error: string };

export function cliOutputRun(
  flags: readonly CliOutputFlag[],
  args: readonly string[],
  commandNames: readonly string[],
  fallback: "auto" | "json" | undefined,
  auto: () => CliForm,
): CliOutputRun {
  const chosen = cliOutputChoice(flags, args, commandNames);
  if (chosen.error !== undefined) return { exitCode: INVALID_INPUT_EXIT_CODE, error: chosen.error };
  return { form: chosen.form ?? (fallback === "auto" ? auto() : "json"), args: chosen.args };
}

const style =
  (color: boolean, open: number, close: number) =>
  (text: string): string =>
    color ? `\u001B[${open}m${text}\u001B[${close}m` : text;

export const cliUi = (color: boolean): CliUi => ({
  bold: style(color, 1, 22),
  dim: style(color, 2, 22),
  ok: style(color, 32, 39),
  warn: style(color, 33, 39),
  error: style(color, 31, 39),
  table,
});

function table(header: readonly string[], rows: readonly (readonly string[])[]): string {
  const lines = [header, ...rows];
  const widths = header.map((_, column) => Math.max(...lines.map((line) => (line[column] ?? "").length)));
  return lines.map((line) => widths.map((width, column) => (line[column] ?? "").padEnd(width)).join("  ").trimEnd()).join("\n");
}

type Scalar = string | number | boolean | null;

const isScalar = (value: unknown): value is Scalar => value === null || typeof value === "string" || typeof value === "number" || typeof value === "boolean";

const isScalarArray = (value: unknown): value is readonly Scalar[] => Array.isArray(value) && value.every(isScalar);

const isRecord = (value: unknown): value is { readonly [key: string]: unknown } => typeof value === "object" && value !== null && !Array.isArray(value);

const isRow = (value: unknown): value is { readonly [key: string]: Scalar | readonly Scalar[] } =>
  isRecord(value) && Object.values(value).every((member) => isScalar(member) || isScalarArray(member));

const indent = (text: string, first: string, other: string): string =>
  text
    .split("\n")
    .map((line, index) => `${index === 0 ? first : other}${line}`.trimEnd())
    .join("\n");

export const cliLayout = (value: unknown): string => (value === null ? "" : layout(value));

function layout(value: unknown): string {
  if (isScalar(value)) return typeof value === "string" ? value : JSON.stringify(value);
  if (isScalarArray(value)) return value.length === 0 ? "(none)" : value.map(layout).join(", ");
  if (Array.isArray(value)) {
    if (value.every(isRow)) {
      const columns = [...new Set(value.flatMap((row) => Object.keys(row)))];
      return table(
        columns,
        value.map((row) => columns.map((column) => (Object.hasOwn(row, column) ? layout(row[column]) : ""))),
      );
    }
    return value.map((item) => indent(layout(item), "- ", "  ")).join("\n");
  }
  if (!isRecord(value)) return JSON.stringify(value);
  const members = Object.entries(value);
  if (members.length === 0) return "(empty)";
  const isOneLine = (member: unknown): boolean => isScalar(member) || isScalarArray(member);
  const width = Math.max(0, ...members.filter(([, member]) => isOneLine(member)).map(([key]) => key.length));
  return members
    .map(([key, member]) => (isOneLine(member) ? `${key.padEnd(width)}  ${layout(member)}`.trimEnd() : `${key}:\n${indent(layout(member), "  ", "  ")}`))
    .join("\n");
}

export interface ListedCapability {
  readonly id: string;
  readonly description: string;
  readonly unavailable?: string | undefined;
}

export function cliListText(capabilities: readonly ListedCapability[], events: readonly { readonly id: string; readonly description: string }[]): string {
  const section = (title: string, rows: readonly (readonly [string, string])[]): string[] => {
    const width = Math.max(0, ...rows.map(([first]) => first.length)) + 2;
    return [title, ...rows.map(([first, description]) => `  ${first.padEnd(width)}${description}`.trimEnd())];
  };
  return [
    ...section(
      "Capabilities",
      capabilities.map(({ id, description, unavailable }) => [id.split(".").join(" "), unavailable === undefined ? description : `${description} (unavailable: ${unavailable})`]),
    ),
    ...(events.length === 0 ? [] : section("Events", events.map(({ id, description }) => [`watch ${id}`, description]))),
  ].join("\n");
}
