import type { EmptyInput, FailureData, FailureSchemas } from "./app.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

export type CliOutput = "human" | "json";

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
    if (!(member === "capability" ? capabilities : events).includes(id)) errors.push(`A format is for the ${member} ${id}, which is not in the view of the command line.`);
  }
  return errors;
}

const AGENT_VARIABLES: readonly string[] = [
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
];

const FALSE_VALUES: readonly string[] = ["", "0", "false", "no", "off"];

const isTruthy = (value: string | undefined): boolean => value !== undefined && !FALSE_VALUES.includes(value.trim().toLowerCase());

export function defaultCliOutput(isTerminal: boolean, env: { readonly [name: string]: string | undefined }): CliOutput {
  if (!isTerminal || isTruthy(env.CI) || AGENT_VARIABLES.some((name) => isTruthy(env[name]))) return "json";
  return "human";
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
