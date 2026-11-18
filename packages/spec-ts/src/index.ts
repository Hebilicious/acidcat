import {
  ALIAS_MESSAGES,
  CALL_FAILURE_KINDS,
  CLI_EXIT_CODES,
  CLI_GENERIC_COMMANDS,
  CLI_RESERVED_FLAGS,
  CLI_RESUME_FLAGS,
  HTTP_STATUS,
  MCP_EVENT_ERRORS,
  MCP_REJECTIONS as REJECTIONS,
  MCP_SUBSCRIPTION_ID,
} from "./facts.generated.ts";

export {
  CALL_FAILURE_KINDS,
  CLI_EXIT_CODES,
  CLI_GENERIC_COMMANDS,
  CLI_RESERVED_FLAGS,
  CLI_RESUME_FLAGS,
  CLI_WATCH_EXIT_CODES,
  HTTP_STATUS,
  INTERRUPT_GRACE_MS,
  KEEPALIVE_MS,
  MCP_EVENT_ERRORS,
  MCP_EVENTS_EXTENSION,
  MCP_PROTOCOL_VERSION,
  MCP_SUBSCRIPTION_ID,
  MCP_UNKNOWN_TOOL,
  SSE_MEDIA_TYPE,
} from "./facts.generated.ts";

export type CallFailureKind = (typeof CALL_FAILURE_KINDS)[number];

export interface CallFailure {
  readonly kind: CallFailureKind;
  readonly message: string;
}

export type Result<Value, Failure> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Failure };

export type Outcome<Value, Failure> = Result<Value, Failure> | CallFailure;

export const ok = <Value>(value: Value): Result<Value, never> => ({ ok: true, value });

export const fail = <const Failure extends { readonly _tag: string }>(failure: Failure): Result<never, Failure> => ({ ok: false, error: failure });

export const callFailure = (kind: CallFailureKind, message: string): CallFailure => ({ kind, message });

export const isCallFailure = (outcome: Outcome<unknown, unknown>): outcome is CallFailure => !("ok" in outcome);

/** The JavaScript error for a call failure (spec/bindings/typescript.md#handles). */
export class CallFailureError extends Error {
  readonly kind: CallFailureKind;

  constructor(failure: CallFailure) {
    super(failure.message);
    this.kind = failure.kind;
    this.name = failure.kind === "cancelled" ? "AbortError" : failure.kind === "invalid-input" ? "TypeError" : "Error";
  }
}

/** The kinds of call failure that a subscription can fail with before its first occurrence, in order of precedence. */
export const SUBSCRIBE_FAILURE_KINDS = ["cancelled", "unknown-capability", "invalid-input", "internal"] as const;

export interface Occurrence<Payload = unknown> {
  readonly eventId: string;
  readonly name: string;
  readonly timestamp: string;
  readonly data: Payload;
  readonly cursor?: string;
  readonly truncated?: true;
}

/** What a provider gives for one occurrence. The binding adds `name`, and makes `eventId` and `timestamp` if they are absent. */
export interface Emitted<Payload = unknown> {
  readonly data: Payload;
  readonly eventId?: string;
  readonly timestamp?: string;
  readonly cursor?: string;
  readonly truncated?: true;
}

export interface Resume {
  readonly cursor?: string;
  readonly maxAgeMs?: number;
}

/**
 * The occurrence for an emitted value. `makeId` gives an `eventId` that is unique in the subscription, and `now` gives
 * the time, when the provider gives none.
 */
export function occurrenceOf<Payload>(name: string, emitted: Emitted<Payload>, makeId: () => string, now: () => Date): Occurrence<Payload> {
  return {
    eventId: emitted.eventId ?? makeId(),
    name,
    timestamp: emitted.timestamp ?? now().toISOString(),
    data: emitted.data,
    ...(emitted.cursor === undefined ? {} : { cursor: emitted.cursor }),
    ...(emitted.truncated === true ? { truncated: true } : {}),
  };
}

/** Tell if a value is an occurrence in its JSON form. `data` can be any JSON object. */
export function isOccurrence(value: unknown): value is Occurrence {
  return (
    isJsonObject(value) &&
    typeof value.eventId === "string" &&
    value.eventId.length > 0 &&
    typeof value.name === "string" &&
    isId(value.name) &&
    typeof value.timestamp === "string" &&
    !Number.isNaN(Date.parse(value.timestamp)) &&
    isJsonObject(value.data) &&
    (value.cursor === undefined || typeof value.cursor === "string") &&
    (value.truncated === undefined || value.truncated === true) &&
    Object.keys(value).every((key) => OCCURRENCE_MEMBERS.has(key))
  );
}

const OCCURRENCE_MEMBERS = new Set(["eventId", "name", "timestamp", "data", "cursor", "truncated"]);

export type Availability = { readonly available: true } | { readonly available: false; readonly reason: string };

export const AVAILABLE: Availability = { available: true };

export const unavailable = (reason: string): Availability => ({ available: false, reason });

export const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$/;

export const isId = (id: string): boolean => id.length <= 128 && ID_PATTERN.test(id);

export const commandPath = (id: string): readonly string[] => id.split(".");

export const cliExitCode = (outcome: Outcome<unknown, unknown>): number =>
  isCallFailure(outcome) ? CLI_EXIT_CODES[outcome.kind] : outcome.ok ? CLI_EXIT_CODES.value : CLI_EXIT_CODES.failure;

/**
 * The flags of a command, as `usage` writes them (spec/bindings/cli.md#commands): required flags first, each group in
 * code point order of the names. `input` is from `cliInputSchema`.
 */
export function cliFlags(input: JsonObject): string[] {
  const properties = objectOrEmpty(input.properties);
  const definitions = objectOrEmpty(input.$defs);
  const required = new Set(stringsOf(input.required));
  const names = Object.keys(properties).sort(byCodePoint);
  return [...names.filter((name) => required.has(name)), ...names.filter((name) => !required.has(name))].map((name) => {
    const property = cliResolve(objectOrEmpty(properties[name]), definitions);
    const items = cliRepeatedItems(property, definitions);
    const flag =
      items !== undefined ? `--${name} <${flagValue(items)}>...` : property.type === "boolean" ? `--${name}` : `--${name} <${flagValue(property)}>`;
    return required.has(name) ? flag : `[${flag}]`;
  });
}

/** A property schema, or the type in `definitions` that its `$ref` refers to. */
export function cliResolve(property: JsonObject, definitions: JsonObject): JsonObject {
  const target = referenceName(property);
  return target === undefined ? property : objectOrEmpty(ownMember(definitions, target) ?? property);
}

/**
 * The schema of the items of a repeated flag (spec/bindings/cli.md#commands), or `undefined` when the property does
 * not give a repeated flag. A property gives a repeated flag when its type is `array`, and its `items` schema, or the
 * type that it refers to, is an `enum` of strings, `integer`, `number` or `string`. `property` is already resolved.
 */
export function cliRepeatedItems(property: JsonObject, definitions: JsonObject): JsonObject | undefined {
  if (property.type !== "array" || !isJsonObject(property.items)) return undefined;
  const items = cliResolve(property.items, definitions);
  return isStringEnum(items.enum) || items.type === "integer" || items.type === "number" || items.type === "string" ? items : undefined;
}

/**
 * The array that a repeated flag gives as JSON text (spec/bindings/cli.md#commands), or `undefined` when its values
 * give one item each. `values` are the values of the flag, in the order of the flags. They give an array as JSON text
 * when the flag occurs exactly once and its value is JSON text of an array.
 */
export function cliJsonArray(values: readonly string[]): readonly unknown[] | undefined {
  const [value] = values;
  if (values.length !== 1 || value === undefined) return undefined;
  try {
    const parsed: unknown = JSON.parse(value);
    return Array.isArray(parsed) ? parsed : undefined;
  } catch {
    return undefined;
  }
}

const isStringEnum = (value: unknown): value is readonly string[] =>
  Array.isArray(value) && value.length > 0 && value.every((item) => typeof item === "string");

function flagValue(property: JsonObject): string {
  if (isStringEnum(property.enum)) return property.enum.join("|");
  if (property.type === "integer" || property.type === "number" || property.type === "string") return property.type;
  return "json";
}

/**
 * The `usage` of a capability in `list` (spec/bindings/cli.md#commands). `input` is from `cliInputSchema`, or
 * `undefined` when the capability has no input.
 */
export function cliUsage(program: string, id: string, input: JsonObject | undefined): string {
  if (input !== undefined && input.properties === undefined) return `${program} call ${id} '<json>'`;
  return [program, ...commandPath(id), ...(input === undefined ? [] : cliFlags(input))].join(" ");
}

/**
 * The `usage` of an event in `list` (spec/bindings/cli.md#events). `input` is from `cliInputSchema`, or `undefined`
 * when the event has no input.
 */
export function cliEventUsage(program: string, id: string, input: JsonObject | undefined): string {
  const resume = "[--cursor <string>] [--max-age-ms <integer>]";
  if (input !== undefined && input.properties === undefined) return `${program} watch ${id} '<json>' ${resume}`;
  return [program, "watch", id, ...(input === undefined ? [] : cliFlags(input)), resume].join(" ");
}

/** The help of a capability, an alias or an event (spec/bindings/cli.md#commands). */
export const cliHelp = (usage: string, description: string): string => `Usage: ${usage}\n\n${description}`;

/**
 * The command list of a shared prefix (spec/bindings/cli.md#commands): the usage of each capability under the prefix,
 * in the order of `capabilities`, the capabilities of `list`. It is `undefined` when `prefix` is not a shared prefix.
 */
export function cliCommandList(prefix: readonly string[], capabilities: readonly { readonly id: string; readonly usage: string }[]): string | undefined {
  const under = capabilities.filter(({ id }) => {
    const path = commandPath(id);
    return path.length > prefix.length && prefix.every((word, index) => path[index] === word);
  });
  if (prefix.length === 0 || under.length === 0) return undefined;
  return ["Commands:", ...under.map(({ usage }) => `  ${usage}`)].join("\n");
}

const CLI_WORD = "[a-z][a-z0-9]*(-[a-z0-9]+)*";

/** The name of an alias: one word, two words with one space between them, or `--` and one word. */
export const CLI_ALIAS_NAME = new RegExp(`^(--${CLI_WORD}|${CLI_WORD}( ${CLI_WORD})?)$`);

const CLI_WORD_ONLY = new RegExp(`^${CLI_WORD}$`);

/**
 * The alias that the first arguments name, with the arguments after its name (spec/bindings/cli.md#aliases), or the
 * words of an unknown command. `paths` are the paths of the commands of the capabilities. The arguments that start with
 * the path of a command name no alias. A word after an alias is an unknown command when the alias is a shared prefix,
 * or when it is a one-word alias whose group has two-word aliases.
 */
export function cliAliasOfArgs<Alias extends { readonly name: string }>(
  aliases: readonly Alias[],
  paths: readonly (readonly string[])[],
  args: readonly string[],
): { readonly alias: Alias; readonly rest: readonly string[] } | { readonly unknownCommand: readonly string[] } | undefined {
  const startsWith = (words: readonly string[]) => words.length <= args.length && words.every((word, index) => args[index] === word);
  if (paths.some(startsWith)) return undefined;
  const [first, second] = args;
  const twoWords = second === undefined ? undefined : aliases.find(({ name }) => name === `${first} ${second}`);
  const named = twoWords ?? aliases.find(({ name }) => name === first);
  if (named === undefined) return undefined;
  const words = named.name.split(" ");
  const next = args[words.length];
  const under = paths.filter((path) => path.length > words.length && words.every((word, index) => path[index] === word));
  if (under.some((path) => path[words.length] === next)) return undefined;
  const prefix = under.length > 0;
  const group = twoWords === undefined && aliases.some(({ name }) => name.startsWith(`${first} `));
  if ((prefix || group) && next !== undefined && CLI_WORD_ONLY.test(next)) return { unknownCommand: [...words, next] };
  return { alias: named, rest: args.slice(words.length) };
}

export interface CliAlias {
  readonly name: string;
  readonly kind: "capability" | "event";
  readonly id: string;
  readonly input?: JsonObject;
}

export interface CliAliases {
  /** The aliases, in code point order of their names. An alias that breaks a rule is not here. */
  readonly aliases: readonly CliAlias[];
  readonly default: CliAlias | undefined;
  readonly errors: readonly string[];
}

/**
 * The aliases of a target in `options.cli.aliases`, and its default alias in `options.cli.default`
 * (spec/bindings/cli.md#aliases). `catalog` is a catalog or the view of the target.
 */
export function cliAliases(catalog: CatalogDocument, target: string): CliAliases {
  const none: CliAliases = { aliases: [], default: undefined, errors: [] };
  const declared = ownMember(catalog.targets, target);
  const settings = declared === undefined || !isJsonObject(declared.options) ? undefined : ownMember(declared.options, "cli");
  if (declared === undefined || settings === undefined) return none;
  const where = `target ${target}`;
  if (!isJsonObject(settings)) return { ...none, errors: [filled(ALIAS_MESSAGES.settingsNotObject, { where })] };
  const errors: string[] = [];
  if (!declared.bindings.includes("cli")) errors.push(filled(ALIAS_MESSAGES.noCliBinding, { where }));
  const declaredAliases = ownMember(settings, "aliases");
  const members = declaredAliases === undefined ? {} : declaredAliases;
  if (!isJsonObject(members)) return { ...none, errors: [...errors, filled(ALIAS_MESSAGES.aliasesNotObject, { where })] };

  const types = catalog.$defs ?? {};
  const inView = (entries: { readonly [id: string]: { readonly audience?: readonly string[]; readonly input?: JsonObject } } | undefined) =>
    Object.entries(entries ?? {}).filter(([, entry]) => (entry.audience ?? []).includes(target));
  const capabilities = new Map(inView(catalog.capabilities).map(([id, capability]) => [id, capability.input]));
  const events = new Map(inView(catalog.events).map(([id, event]) => [id, event.input]));
  const paths = new Set([...capabilities.keys()].map((id) => commandPath(id).join(" ")));
  const aliases: CliAlias[] = [];
  for (const name of Object.keys(members).sort(byCodePoint)) {
    const problem = (template: string, parts: { readonly [part: string]: string } = {}) => errors.push(filled(template, { where, name, ...parts }));
    const value = members[name];
    if (!CLI_ALIAS_NAME.test(name)) {
      problem(ALIAS_MESSAGES.badName);
      continue;
    }
    const [leading = name, second] = name.split(" ");
    if (name.startsWith("--") ? isOneOf(CLI_RESERVED_FLAGS, name) : isOneOf(CLI_GENERIC_COMMANDS, leading)) {
      problem(second === undefined ? ALIAS_MESSAGES.reservedName : ALIAS_MESSAGES.reservedFirstWord);
      continue;
    }
    if (paths.has(name)) {
      problem(ALIAS_MESSAGES.commandPath);
      continue;
    }
    if (!isJsonObject(value) || typeof (value.capability ?? value.event) !== "string" || (value.capability !== undefined && value.event !== undefined)) {
      problem(ALIAS_MESSAGES.badTarget);
      continue;
    }
    const unknown = Object.keys(value).filter((key) => key !== "capability" && key !== "event" && key !== "input" && !key.startsWith("x-"));
    if (unknown.length > 0) {
      problem(ALIAS_MESSAGES.unknownMember, { members: unknown.join(", ") });
      continue;
    }
    const kind = typeof value.event === "string" ? "event" : "capability";
    const id = typeof value.event === "string" ? value.event : typeof value.capability === "string" ? value.capability : "";
    const entries = kind === "event" ? events : capabilities;
    if (!entries.has(id)) {
      problem(ALIAS_MESSAGES.notInView, { id, kind: kind === "event" ? "an event" : "a capability" });
      continue;
    }
    if (value.input === undefined) {
      aliases.push({ name, kind, id });
      continue;
    }
    if (!isJsonObject(value.input)) {
      problem(ALIAS_MESSAGES.inputNotObject);
      continue;
    }
    const input = entries.get(id);
    const properties = input === undefined ? undefined : resolveType(input, types).properties;
    if (!isJsonObject(properties)) {
      problem(ALIAS_MESSAGES.noProperties, { id });
      continue;
    }
    const extra = Object.keys(value.input).filter((key) => !Object.hasOwn(properties, key));
    if (extra.length > 0) {
      problem(ALIAS_MESSAGES.notAProperty, { members: extra.join(", "), id });
      continue;
    }
    aliases.push({ name, kind, id, input: value.input });
  }

  const named = settings.default;
  if (named === undefined) return { aliases, default: undefined, errors };
  const fallback = typeof named === "string" ? aliases.find((alias) => alias.name === named) : undefined;
  if (typeof named !== "string" || named.startsWith("--") || (fallback === undefined && !Object.hasOwn(members, named))) {
    errors.push(filled(ALIAS_MESSAGES.badDefault, { where }));
    return { aliases, default: undefined, errors };
  }
  if (fallback === undefined) return { aliases, default: undefined, errors };
  const flags = cliAliasFlagNames(catalog, fallback);
  for (const reserved of CLI_RESERVED_FLAGS) {
    if (flags.includes(reserved.slice(2))) errors.push(filled(ALIAS_MESSAGES.defaultHasReservedFlag, { where, name: fallback.name, flag: reserved }));
  }
  for (const alias of aliases) {
    if (alias.name.startsWith("--") && flags.includes(alias.name.slice(2))) {
      errors.push(filled(ALIAS_MESSAGES.flagOfDefault, { where, name: alias.name, default: fallback.name }));
    }
  }
  return { aliases, default: fallback, errors };
}

/**
 * The input schema of an alias (spec/bindings/cli.md#aliases): the input schema of its capability or its event, from
 * `cliInputSchema`, without the properties of the fixed input. The flags of the alias come from it. `catalog` is a
 * catalog or the view that has the alias.
 */
export function cliAliasInput(catalog: CatalogDocument, alias: CliAlias): JsonObject | undefined {
  const entry = alias.kind === "event" ? ownMember(catalog.events ?? {}, alias.id) : ownMember(catalog.capabilities, alias.id);
  return entry?.input === undefined ? undefined : cliAliasSchema(cliInputSchema(entry.input, catalog.$defs ?? {}), alias.input);
}

/** The names of the flags of an alias, without `--`: its input properties, and the cursor flags of an event. */
export function cliAliasFlagNames(catalog: CatalogDocument, alias: CliAlias): readonly string[] {
  const properties = cliAliasInput(catalog, alias)?.properties;
  return [...(isJsonObject(properties) ? Object.keys(properties) : []), ...(alias.kind === "event" ? CLI_RESUME_FLAGS : [])];
}

/**
 * An input schema from `cliInputSchema`, without the properties of the fixed input of an alias
 * (spec/bindings/cli.md#aliases).
 */
export function cliAliasSchema(input: JsonObject, fixed: JsonObject | undefined): JsonObject {
  if (fixed === undefined || !isJsonObject(input.properties)) return input;
  const properties = Object.fromEntries(Object.entries(input.properties).filter(([name]) => !Object.hasOwn(fixed, name)));
  const required = stringsOf(input.required).filter((name) => !Object.hasOwn(fixed, name));
  const { required: _, ...rest } = input;
  return { ...rest, properties, ...(required.length > 0 ? { required } : {}) };
}

/**
 * The `usage` of an alias in `list` (spec/bindings/cli.md#aliases). `input` is the input schema of the alias, from
 * `cliAliasInput`, or `undefined` when it has no input. The usage of an alias of an event ends with the cursor flags.
 */
export function cliAliasUsage(program: string, alias: Pick<CliAlias, "name" | "kind">, input: JsonObject | undefined): string {
  const flags = input === undefined ? [] : input.properties === undefined ? ["'<json>'"] : cliFlags(input);
  const resume = alias.kind === "event" ? ["[--cursor <string>] [--max-age-ms <integer>]"] : [];
  return [program, alias.name, ...flags, ...resume].join(" ");
}

const isOneOf = (names: readonly string[], name: string): boolean => names.includes(name);

const filled = (template: string, parts: { readonly [part: string]: string }): string =>
  template.replaceAll(/\{(\w+)\}/g, (placeholder, part: string) => parts[part] ?? placeholder);

export const httpStatus = (outcome: Outcome<unknown, unknown>): number =>
  isCallFailure(outcome) ? HTTP_STATUS[outcome.kind] : 200;

/** One message of a stream of server-sent events, as text, with the blank line that ends it. */
export function sseMessage(fields: { readonly event?: string | undefined; readonly id?: string | undefined; readonly data: string }): string {
  const lines = [
    ...(fields.event === undefined ? [] : [`event: ${fields.event}`]),
    ...(fields.id === undefined ? [] : [`id: ${fields.id}`]),
    ...fields.data.split("\n").map((line) => (line === "" ? "data:" : `data: ${line}`)),
  ];
  return `${lines.join("\n")}\n\n`;
}

/** The messages of a subscription through the HTTP binding (spec/bindings/http.md#events). */
export const httpEventMessage = {
  next: (occurrence: Occurrence): string => sseMessage({ event: "next", id: occurrence.cursor, data: JSON.stringify(occurrence) }),
  complete: (): string => sseMessage({ event: "complete", data: "" }),
  error: (failure: CallFailure): string => sseMessage({ event: "error", data: JSON.stringify({ kind: failure.kind, message: failure.message }) }),
  keepalive: (): string => ":\n\n",
} as const;

export type Rejection = "method" | "origin" | "media-type" | "too-large" | "not-utf8";

/**
 * The first rule that a request breaks, before its body is read: method, origin, media type, declared length.
 * The body itself is checked as it arrives, with `readBounded`.
 */
export function screenRequest(
  request: Request,
  rules: {
    readonly methods: readonly string[];
    readonly allowedOrigins: readonly string[];
    readonly mediaType: string;
    readonly maximumBytes: number;
  },
): Rejection | undefined {
  if (!rules.methods.includes(request.method)) return "method";
  const origin = request.headers.get("Origin");
  if (origin !== null && !rules.allowedOrigins.includes(origin)) return "origin";
  if (request.method === "GET" || request.method === "HEAD") return undefined;
  const mediaType = ((request.headers.get("Content-Type") ?? "").split(";")[0] ?? "").trim().toLowerCase();
  if (mediaType !== rules.mediaType) return "media-type";
  const declared = Number(request.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > rules.maximumBytes) return "too-large";
  return undefined;
}

/** Read a request body as UTF-8 text. Count the bytes as they arrive, and stop at the limit. */
export async function readBounded(
  request: Request,
  maximumBytes: number,
): Promise<{ readonly text: string } | { readonly rejection: Rejection }> {
  if (request.body === null) return { text: "" };
  const reader = request.body.getReader();
  const chunks: Uint8Array[] = [];
  let length = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    length += value.byteLength;
    if (length > maximumBytes) {
      await reader.cancel().catch(() => undefined);
      return { rejection: "too-large" };
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(length);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  try {
    return { text: new TextDecoder("utf-8", { fatal: true }).decode(bytes) };
  } catch {
    return { rejection: "not-utf8" };
  }
}

export const MCP_REJECTIONS: { readonly [R in Rejection]: { readonly status: number; readonly code?: number } } = REJECTIONS;

/** The JSON-RPC error for a call failure of a subscription before its first occurrence. */
export function mcpSubscribeError(failure: CallFailure): { readonly code: number; readonly message: string; readonly data?: JsonObject } {
  if (failure.kind === "unknown-capability") return { code: MCP_EVENT_ERRORS.notFound, message: failure.message, data: { kind: "event" } };
  if (failure.kind === "invalid-input") return { code: MCP_EVENT_ERRORS.invalidParams, message: failure.message };
  return { code: MCP_EVENT_ERRORS.internal, message: failure.message };
}

/** An entry of `events/list`. `input` and `payload` are the bundled schemas. */
export function mcpEventEntry(
  id: string,
  description: string,
  input: JsonObject | undefined,
  payload: JsonObject | undefined,
  webhook = false,
): JsonObject {
  return {
    name: id,
    description,
    delivery: webhook ? ["push", "poll", "webhook"] : ["push", "poll"],
    inputSchema: input ?? { type: "object" },
    payloadSchema: payload ?? { type: "object" },
  };
}

/** The params of `notifications/events/event` for an occurrence: the occurrence without `truncated`. */
export function mcpEventParams(occurrence: Occurrence, subscriptionId: string | number): JsonObject {
  const { truncated: _, ...rest } = occurrence;
  return { ...rest, _meta: { [MCP_SUBSCRIPTION_ID]: subscriptionId } };
}

/**
 * Order strings by Unicode code point. The `<` operator compares UTF-16 code units, which put a character after U+FFFF
 * before a character from U+E000 to U+FFFF.
 */
export function byCodePoint(left: string, right: string): number {
  const a = Array.from(left, (character) => character.codePointAt(0) ?? 0);
  const b = Array.from(right, (character) => character.codePointAt(0) ?? 0);
  for (let i = 0; i < Math.min(a.length, b.length); i += 1) {
    const difference = (a[i] ?? 0) - (b[i] ?? 0);
    if (difference !== 0) return difference;
  }
  return a.length - b.length;
}

/** The canonical JSON of a value (spec/bindings/mcp.md#canonical-json): no spaces, and the keys of each object in code point order. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (isJsonObject(value)) {
    const keys = Object.keys(value).sort(byCodePoint);
    return `{${keys.map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(",")}}`;
  }
  return JSON.stringify(value) ?? "null";
}

/** The defaults of poll delivery (spec/bindings/mcp.md#poll). */
export const MCP_POLL_DEFAULTS = { leaseMs: 300_000, bufferLimit: 1000, maxEvents: 100, nextPollMs: 2000 } as const;

/** Where a poll cursor points: a lease, a position in its buffer, and the last cursor of the provider. */
export interface PollPosition {
  readonly lease: string;
  readonly position: number;
  readonly provider?: string;
}

/** The cursor of a poll position. Only the server reads it. */
export function encodePollCursor(position: PollPosition): string {
  const parts = position.provider === undefined ? [position.lease, position.position] : [position.lease, position.position, position.provider];
  return `p1.${base64UrlOfText(JSON.stringify(parts))}`;
}

export function decodePollCursor(cursor: string): PollPosition | undefined {
  if (!cursor.startsWith("p1.")) return undefined;
  let parts: unknown;
  try {
    parts = JSON.parse(textOfBase64Url(cursor.slice(3)));
  } catch {
    return undefined;
  }
  if (!Array.isArray(parts) || parts.length < 2 || parts.length > 3) return undefined;
  const items: readonly unknown[] = parts;
  const [lease, position, provider] = items;
  if (typeof lease !== "string" || typeof position !== "number" || !Number.isSafeInteger(position) || position < 0) return undefined;
  if (provider !== undefined && typeof provider !== "string") return undefined;
  return provider === undefined ? { lease, position } : { lease, position, provider };
}

function base64UrlOfText(text: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(text)) binary += String.fromCharCode(byte);
  return btoa(binary).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

function textOfBase64Url(text: string): string {
  const binary = atob(text.replaceAll("-", "+").replaceAll("_", "/"));
  return new TextDecoder("utf-8", { fatal: true }).decode(Uint8Array.from(binary, (character) => character.charCodeAt(0)));
}

/** The defaults of webhook delivery (spec/bindings/mcp.md#webhook). */
export const MCP_WEBHOOK_DEFAULTS = {
  maxTtlMs: 3_600_000,
  minTtlMs: 60_000,
  maxSubscriptions: 100,
  attempts: 5,
  retryWindowMs: 900_000,
  timeoutMs: 5000,
  rotationGraceMs: 300_000,
} as const;

/** The reasons of a `CallbackEndpointError`, and the values of `lastError` (spec/bindings/mcp.md#webhook). */
export const WEBHOOK_ERRORS = ["challenge_failed", "connection_refused", "timeout", "tls_error", "http_4xx", "http_5xx"] as const;

export type WebhookError = (typeof WEBHOOK_ERRORS)[number];

/** The bytes of a Standard Webhooks secret: `whsec_` and the base64 of 24 to 64 bytes. `undefined` when it is not valid. */
export function webhookSecretBytes(secret: string): Uint8Array<ArrayBuffer> | undefined {
  if (!secret.startsWith("whsec_")) return undefined;
  const text = secret.slice(6);
  if (!/^[A-Za-z0-9+/]*={0,2}$/.test(text) || text.length % 4 !== 0) return undefined;
  let binary: string;
  try {
    binary = atob(text);
  } catch {
    return undefined;
  }
  return binary.length >= 24 && binary.length <= 64 ? Uint8Array.from(binary, (character) => character.charCodeAt(0)) : undefined;
}

/** The lifetime that the server grants for a suggested `ttlMs` (spec/bindings/mcp.md#webhook). */
export function webhookGrantMs(ttlMs: number | null | undefined, limits: { readonly maxTtlMs: number; readonly minTtlMs: number }): number {
  if (ttlMs === null || ttlMs === undefined) return limits.maxTtlMs;
  return Math.min(limits.maxTtlMs, Math.max(limits.minTtlMs, ttlMs));
}

/** The text that a Standard Webhooks signature covers. */
export const webhookSignedText = (webhookId: string, timestamp: number, body: string): string => `${webhookId}.${timestamp}.${body}`;

/** The `webhook-signature` header: one `v1,` signature for each secret, with a space between them. */
export async function webhookSignature(secrets: readonly string[], webhookId: string, timestamp: number, body: string): Promise<string> {
  const content = new TextEncoder().encode(webhookSignedText(webhookId, timestamp, body));
  const signatures: string[] = [];
  for (const secret of secrets) {
    const bytes = webhookSecretBytes(secret);
    if (bytes === undefined) throw new TypeError("A webhook secret is not valid.");
    const key = await crypto.subtle.importKey("raw", bytes, { name: "HMAC", hash: "SHA-256" }, false, ["sign"]);
    const mac = new Uint8Array(await crypto.subtle.sign("HMAC", key, content));
    let binary = "";
    for (const byte of mac) binary += String.fromCharCode(byte);
    signatures.push(`v1,${btoa(binary)}`);
  }
  return signatures.join(" ");
}

/** The subscription id of a webhook subscription: `sub_` and 16 hexadecimal digits of the SHA-256 of its key. */
export async function webhookSubscriptionId(principal: string, url: string, id: string, input: unknown): Promise<string> {
  const digest = new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(canonicalJson([principal, url, id, input]))));
  return `sub_${Array.from(digest.slice(0, 8), (byte) => byte.toString(16).padStart(2, "0")).join("")}`;
}

/**
 * Tell if an IP address is globally routable: not in a special-purpose range of the IANA IPv4 and IPv6 registries that
 * is not global, for example loopback, private, link-local, shared, documentation or multicast addresses.
 */
export function isGloballyRoutable(address: string): boolean {
  const ipv4 = ipv4Bytes(address);
  if (ipv4 !== undefined) return isGlobalIpv4(ipv4);
  const ipv6 = ipv6Words(address);
  if (ipv6 === undefined) return false;
  if (inIpv6Range(ipv6, IPV4_MAPPED)) {
    const [g = 0, h = 0] = ipv6.slice(6);
    return isGlobalIpv4([g >> 8, g & 255, h >> 8, h & 255]);
  }
  if (IPV6_NOT_GLOBAL.some((range) => inIpv6Range(ipv6, range))) return false;
  return inIpv6Range(ipv6, IPV6_GLOBAL_UNICAST);
}

interface Ipv6Range {
  readonly words: readonly number[];
  readonly prefixLength: number;
}

function ipv6Range(cidr: string): Ipv6Range {
  const [address = "", prefixLength = ""] = cidr.split("/");
  const words = ipv6Words(address);
  if (words === undefined || !/^\d+$/.test(prefixLength)) throw new Error(`${cidr} is not an IPv6 range`);
  return { words, prefixLength: Number(prefixLength) };
}

function inIpv6Range(words: readonly number[], range: Ipv6Range): boolean {
  return words.every((word, index) => {
    const bits = Math.min(16, Math.max(0, range.prefixLength - 16 * index));
    const mask = (0xffff << (16 - bits)) & 0xffff;
    return (word & mask) === ((range.words[index] ?? 0) & mask);
  });
}

const IPV4_MAPPED = ipv6Range("::ffff:0:0/96");
const IPV6_GLOBAL_UNICAST = ipv6Range("2000::/3");
const IPV6_NOT_GLOBAL = [
  "::/128",
  "::1/128",
  "64:ff9b::/96",
  "64:ff9b:1::/48",
  "100::/64",
  "2001::/23",
  "2001:db8::/32",
  "2002::/16",
  "3fff::/20",
  "5f00::/16",
  "fc00::/7",
  "fe80::/10",
  "ff00::/8",
].map(ipv6Range);

function isGlobalIpv4([a = 0, b = 0, c = 0]: readonly number[]): boolean {
  if (a === 0 || a === 10 || a === 127) return false;
  if (a === 100 && b >= 64 && b <= 127) return false;
  if (a === 169 && b === 254) return false;
  if (a === 172 && b >= 16 && b <= 31) return false;
  if (a === 192 && b === 0 && (c === 0 || c === 2)) return false;
  if (a === 192 && b === 88 && c === 99) return false;
  if (a === 192 && b === 168) return false;
  if (a === 198 && (b === 18 || b === 19)) return false;
  if (a === 198 && b === 51 && c === 100) return false;
  if (a === 203 && b === 0 && c === 113) return false;
  return a < 224;
}

function ipv4Bytes(address: string): number[] | undefined {
  const parts = address.split(".");
  if (parts.length !== 4 || !parts.every((part) => /^(0|[1-9][0-9]{0,2})$/.test(part))) return undefined;
  const bytes = parts.map(Number);
  return bytes.every((byte) => byte <= 255) ? bytes : undefined;
}

function splitEmbeddedIpv4(address: string): { readonly hexadecimal: string; readonly ipv4Words: readonly number[] } {
  const lastColon = address.lastIndexOf(":");
  const ipv4 = lastColon === -1 ? undefined : ipv4Bytes(address.slice(lastColon + 1));
  if (ipv4 === undefined) return { hexadecimal: address, ipv4Words: [] };
  const [w = 0, x = 0, y = 0, z = 0] = ipv4;
  const head = address.slice(0, lastColon + 1);
  return { hexadecimal: head.endsWith("::") ? head : head.slice(0, -1), ipv4Words: [(w << 8) | x, (y << 8) | z] };
}

function ipv6Words(input: string): number[] | undefined {
  let address = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);
  const { hexadecimal, ipv4Words } = splitEmbeddedIpv4(address);
  const halves = hexadecimal.split("::");
  if (halves.length > 2) return undefined;
  const words = (text: string) => (text === "" ? [] : text.split(":"));
  const head = words(halves[0] ?? "");
  const rest = halves.length === 2 ? words(halves[1] ?? "") : [];
  if (![...head, ...rest].every((word) => /^[0-9a-fA-F]{1,4}$/.test(word))) return undefined;
  const count = head.length + rest.length + ipv4Words.length;
  if (halves.length === 1 ? count !== 8 : count > 7) return undefined;
  const zeros = halves.length === 2 ? Array.from({ length: 8 - count }, () => 0) : [];
  return [...head.map((word) => parseInt(word, 16)), ...zeros, ...rest.map((word) => parseInt(word, 16)), ...ipv4Words];
}

export interface McpToolResult {
  readonly content: readonly [{ readonly type: "text"; readonly text: string }];
  readonly isError?: true;
  readonly structuredContent?: unknown;
}

/** The MCP tool result for an outcome that is not `unknown-capability`. */
export function mcpToolResult(outcome: Outcome<unknown, unknown>, hasOutputSchema: boolean): McpToolResult {
  const text = (value: unknown) => [{ type: "text", text: JSON.stringify(value) }] as const;
  if (isCallFailure(outcome)) return { content: text({ kind: outcome.kind, message: outcome.message }), isError: true };
  if (!outcome.ok) return { content: text({ ok: false, error: outcome.error }), isError: true };
  return hasOutputSchema
    ? { content: text(outcome.value), structuredContent: outcome.value }
    : { content: text(outcome.value) };
}

export interface McpToolAnnotations {
  readonly readOnlyHint: boolean;
  readonly destructiveHint?: boolean;
  readonly idempotentHint?: boolean;
}

/** A hint that the capability does not give has no annotation. */
export function mcpToolAnnotations(capability: CatalogCapability): McpToolAnnotations {
  return {
    readOnlyHint: capability.readOnly === true,
    ...(capability.destructive === undefined ? {} : { destructiveHint: capability.destructive }),
    ...(capability.idempotent === undefined ? {} : { idempotentHint: capability.idempotent }),
  };
}

export type JsonObject = { readonly [key: string]: unknown };

export interface CatalogCapability extends JsonObject {
  readonly description: string;
  readonly audience?: readonly string[];
  readonly input?: JsonObject;
  readonly output?: JsonObject;
  readonly failures?: { readonly [tag: string]: JsonObject };
  readonly readOnly?: boolean;
  readonly destructive?: boolean;
  readonly idempotent?: boolean;
  readonly state?: JsonObject;
}

export interface CatalogEvent extends JsonObject {
  readonly description: string;
  readonly audience?: readonly string[];
  readonly input?: JsonObject;
  readonly payload?: JsonObject;
}

export interface CatalogDocument extends JsonObject {
  readonly acidcat: string;
  readonly title?: string;
  readonly description?: string;
  readonly targets: { readonly [name: string]: JsonObject & { readonly bindings: readonly string[] } };
  readonly $defs?: { readonly [name: string]: JsonObject };
  readonly capabilities: { readonly [id: string]: CatalogCapability };
  readonly events?: { readonly [id: string]: CatalogEvent };
}

export const REFERENCE = /^#\/\$defs\/([A-Za-z][A-Za-z0-9_]*)$/;

const referenceName = (schema: JsonObject): string | undefined =>
  typeof schema.$ref === "string" ? REFERENCE.exec(schema.$ref)?.[1] : undefined;

export const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The member of an object with this key, or `undefined` when the object does not have it. Inherited names, such as
 * `constructor` or `toString`, are not members.
 */
export function ownMember<Value>(object: { readonly [key: string]: Value }, key: string): Value | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

const objectOrEmpty = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});

const stringsOf = (value: unknown): readonly string[] =>
  Array.isArray(value) ? value.filter((item): item is string => typeof item === "string") : [];

/** The schemas of a capability, each with the member that holds it. */
export function schemasOf(capability: CatalogCapability): readonly (readonly [string, JsonObject])[] {
  const members: (readonly [string, JsonObject | undefined])[] = [
    ["input", capability.input],
    ["output", capability.output],
    ["state", capability.state],
    ...Object.entries(capability.failures ?? {}).map(([tag, schema]) => [`failure ${tag}`, schema] as const),
  ];
  return members.filter((entry): entry is readonly [string, JsonObject] => entry[1] !== undefined);
}

/** The schemas of an event, each with the member that holds it. */
export function eventSchemasOf(event: CatalogEvent): readonly (readonly [string, JsonObject])[] {
  const members: (readonly [string, JsonObject | undefined])[] = [
    ["input", event.input],
    ["payload", event.payload],
  ];
  return members.filter((entry): entry is readonly [string, JsonObject] => entry[1] !== undefined);
}

export function visitObjects(value: unknown, onObject: (node: JsonObject) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visitObjects(item, onObject));
  } else if (isJsonObject(value)) {
    onObject(value);
    Object.values(value).forEach((item) => visitObjects(item, onObject));
  }
}

/** The types that a schema uses, directly or through other types. */
export function typesUsedBy(schema: unknown, types: { readonly [name: string]: JsonObject }): Map<string, JsonObject> {
  const used = new Map<string, JsonObject>();
  const collect = (node: unknown) =>
    visitObjects(node, (inner) => {
      const name = referenceName(inner);
      const type = name === undefined ? undefined : ownMember(types, name);
      if (name !== undefined && type !== undefined && !used.has(name)) {
        used.set(name, type);
        collect(type);
      }
    });
  collect(schema);
  return used;
}

/**
 * An input schema that is a union of object schemas, with `"type": "object"`, so that it is an object schema
 * (spec/catalog.md#capabilities). A union is `anyOf` or `oneOf`, directly or in the type that a `$ref` names. Each of
 * its schemas is an object, or a `$ref` to a type that is an object. Other schemas do not change.
 */
export function objectInput(schema: JsonObject, types: { readonly [name: string]: JsonObject }): JsonObject {
  const resolve = (node: unknown): JsonObject | undefined => {
    if (!isJsonObject(node)) return undefined;
    const name = referenceName(node);
    return name === undefined ? node : ownMember(types, name);
  };
  const target = resolve(schema);
  if (schema.type !== undefined || target === undefined || target.type !== undefined) return schema;
  const union = target.anyOf ?? target.oneOf;
  if (!Array.isArray(union) || union.length === 0) return schema;
  return union.every((member) => resolve(member)?.type === "object") ? { type: "object", ...schema } : schema;
}

/**
 * The type that a schema's `$ref` refers to, whatever other keys the schema has, or the schema itself when it has no
 * `$ref` to a type in `types`. A catalog uses it to tell if an input or a payload is an object
 * (spec/catalog.md#capabilities).
 */
export function resolveType(schema: JsonObject, types: { readonly [name: string]: JsonObject }): JsonObject {
  const name = referenceName(schema);
  return (name === undefined ? undefined : ownMember(types, name)) ?? schema;
}

/** Bundle a schema (spec/catalog.md#bundling). */
export function bundle(schema: JsonObject, types: { readonly [name: string]: JsonObject }): JsonObject {
  const base = Object.keys(schema).length === 1 ? resolveType(schema, types) : schema;
  const used = typesUsedBy(base, types);
  return used.size === 0 ? base : { ...base, $defs: Object.fromEntries(used) };
}

/**
 * The input schema that the CLI binding reads (spec/bindings/cli.md#commands): the bundled type that the `$ref` of the
 * schema refers to, whatever other keys the schema has, as `resolveType` gives it. The flags, the usage and the choice
 * of JSON text come from it.
 */
export function cliInputSchema(schema: JsonObject, types: { readonly [name: string]: JsonObject }): JsonObject {
  return bundle(resolveType(schema, types), types);
}

/** The view of a target (spec/catalog.md#views). */
export function viewOf(catalog: CatalogDocument, target: string): CatalogDocument {
  const types = catalog.$defs ?? {};
  const capabilities = Object.fromEntries(
    Object.entries(catalog.capabilities)
      .filter(([, capability]) => (capability.audience ?? []).includes(target))
      .map(([id, capability]) => [id, { ...capability, audience: [target] }]),
  );
  const events = Object.fromEntries(
    Object.entries(catalog.events ?? {})
      .filter(([, event]) => (event.audience ?? []).includes(target))
      .map(([id, event]) => [id, { ...event, audience: [target] }]),
  );
  const used = new Map<string, JsonObject>();
  const schemas = [...Object.values(capabilities).flatMap(schemasOf), ...Object.values(events).flatMap(eventSchemasOf)];
  for (const [, schema] of schemas) for (const [name, type] of typesUsedBy(schema, types)) used.set(name, type);
  const { $defs: _, events: __, ...rest } = catalog;
  const declared = ownMember(catalog.targets, target);
  return {
    ...rest,
    targets: declared === undefined ? {} : { [target]: declared },
    ...(used.size > 0 ? { $defs: Object.fromEntries(used) } : {}),
    capabilities,
    ...(Object.keys(events).length > 0 ? { events } : {}),
  };
}
