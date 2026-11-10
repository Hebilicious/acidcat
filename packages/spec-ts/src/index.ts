/**
 * The fixed details of the AcidCat specification, as TypeScript data and pure functions, for the TypeScript reference
 * implementation. This package has no dependencies.
 *
 * - Outcomes and call failures: spec/invocation.md
 * - Subscriptions and occurrences: spec/events.md
 * - Names, views and bundling: spec/catalog.md
 * - Exit codes, status codes and MCP results: spec/bindings/
 */

// ---------------------------------------------------------------------------------------------------------------
// Outcomes (spec/invocation.md#outcomes)
// ---------------------------------------------------------------------------------------------------------------

/** The kinds of call failure, in order of precedence: when more than one applies, the first one is used. */
export const CALL_FAILURE_KINDS = ["cancelled", "unknown-capability", "unavailable", "invalid-input", "internal"] as const;

export type CallFailureKind = (typeof CALL_FAILURE_KINDS)[number];

/** A call that did not give a result. */
export interface CallFailure {
  readonly kind: CallFailureKind;
  readonly message: string;
}

/** A value or a failure. */
export type Result<Value, Failure> =
  | { readonly ok: true; readonly value: Value }
  | { readonly ok: false; readonly error: Failure };

/** The end of a call: a value, a failure or a call failure. */
export type Outcome<Value, Failure> = Result<Value, Failure> | CallFailure;

export const ok = <Value>(value: Value): Result<Value, never> => ({ ok: true, value });

/** A failure, with its tag in `_tag`, as a result: `fail({ _tag: "Offline" })`. */
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

// ---------------------------------------------------------------------------------------------------------------
// Events (spec/events.md)
// ---------------------------------------------------------------------------------------------------------------

/** The kinds of call failure that a subscription can fail with before its first occurrence, in order of precedence. */
export const SUBSCRIBE_FAILURE_KINDS = ["cancelled", "unknown-capability", "invalid-input", "internal"] as const;

/** One thing that happened, in its JSON form (spec/events.md#occurrences). */
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

/** Where a subscription starts (spec/events.md#resuming). */
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

/** The time with no message on a stream after which a binding sends a keepalive or a heartbeat, in milliseconds. */
export const KEEPALIVE_MS = 15_000;

// ---------------------------------------------------------------------------------------------------------------
// Availability (spec/invocation.md#availability)
// ---------------------------------------------------------------------------------------------------------------

export type Availability = { readonly available: true } | { readonly available: false; readonly reason: string };

export const AVAILABLE: Availability = { available: true };

export const unavailable = (reason: string): Availability => ({ available: false, reason });

// ---------------------------------------------------------------------------------------------------------------
// Names (spec/catalog.md#ids)
// ---------------------------------------------------------------------------------------------------------------

export const ID_PATTERN = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$/;

export const isId = (id: string): boolean => id.length <= 128 && ID_PATTERN.test(id);

/** The path of the CLI command for an id: `aircon.power.set` → `["aircon", "power", "set"]`. */
export const commandPath = (id: string): readonly string[] => id.split(".");


// ---------------------------------------------------------------------------------------------------------------
// CLI binding (spec/bindings/cli.md#outcomes)
// ---------------------------------------------------------------------------------------------------------------

export const CLI_EXIT_CODES = {
  value: 0,
  failure: 1,
  "unknown-capability": 2,
  "invalid-input": 3,
  unavailable: 4,
  internal: 5,
  cancelled: 130,
} as const;

export const cliExitCode = (outcome: Outcome<unknown, unknown>): number =>
  isCallFailure(outcome) ? CLI_EXIT_CODES[outcome.kind] : outcome.ok ? CLI_EXIT_CODES.value : CLI_EXIT_CODES.failure;

/**
 * The flags of a command, as `usage` writes them (spec/bindings/cli.md#commands): required flags first, each group in
 * code point order of the names. `input` is the bundled input schema.
 */
export function cliFlags(input: JsonObject): string[] {
  const properties = objectOrEmpty(input.properties);
  const definitions = objectOrEmpty(input.$defs);
  const required = new Set(stringsOf(input.required));
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const names = Object.keys(properties).sort(byName);
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
  const target = typeof property.$ref === "string" ? REFERENCE.exec(property.$ref)?.[1] : undefined;
  return target === undefined ? property : objectOrEmpty(definitions[target] ?? property);
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
 * The `usage` of a capability in `list` (spec/bindings/cli.md#commands). `input` is the bundled input schema, or
 * `undefined` when the capability has no input.
 */
export function cliUsage(program: string, id: string, input: JsonObject | undefined): string {
  if (input !== undefined && input.properties === undefined) return `${program} call ${id} '<json>'`;
  return [program, ...commandPath(id), ...(input === undefined ? [] : cliFlags(input))].join(" ");
}

/**
 * The `usage` of an event in `list` (spec/bindings/cli.md#events). `input` is the bundled input schema, or `undefined`
 * when the event has no input.
 */
export function cliEventUsage(program: string, id: string, input: JsonObject | undefined): string {
  if (input !== undefined && input.properties === undefined) return `${program} watch ${id} '<json>'`;
  return [program, "watch", id, ...(input === undefined ? [] : cliFlags(input))].join(" ");
}

/** The exit code for each end of a subscription through the CLI (spec/bindings/cli.md#events). */
export const CLI_WATCH_EXIT_CODES = { complete: 0, cancelled: 130, internal: 5 } as const;

// ---------------------------------------------------------------------------------------------------------------
// HTTP binding (spec/bindings/http.md)
// ---------------------------------------------------------------------------------------------------------------

export const HTTP_STATUS = {
  "unknown-capability": 404,
  "invalid-input": 422,
  unavailable: 503,
  cancelled: 409,
  internal: 500,
} as const;

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

/** The media type of a stream of server-sent events. */
export const SSE_MEDIA_TYPE = "text/event-stream";

// ---------------------------------------------------------------------------------------------------------------
// Remote bindings (spec/bindings/README.md#remote-bindings)
// ---------------------------------------------------------------------------------------------------------------

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

// ---------------------------------------------------------------------------------------------------------------
// MCP binding (spec/bindings/mcp.md)
// ---------------------------------------------------------------------------------------------------------------

export const MCP_PROTOCOL_VERSION = "2026-07-28";

export const MCP_UNKNOWN_TOOL = -32602;

/** The HTTP status and JSON-RPC error code for each rejected MCP request. */
export const MCP_REJECTIONS: { readonly [R in Rejection]: { readonly status: number; readonly code?: number } } = {
  method: { status: 405 },
  origin: { status: 403 },
  "media-type": { status: 415 },
  "too-large": { status: 413, code: -32600 },
  "not-utf8": { status: 400, code: -32700 },
};

/** The identifier of the MCP events extension (spec/bindings/mcp.md#events). */
export const MCP_EVENTS_EXTENSION = "io.modelcontextprotocol/events";

/** The key in `params._meta` that holds the id of the `events/stream` request. */
export const MCP_SUBSCRIPTION_ID = "io.modelcontextprotocol/subscriptionId";

/** The JSON-RPC errors of the MCP events extension. Their numbers are not final in SEP-3415. */
export const MCP_EVENT_ERRORS = {
  notFound: -32023,
  unsupported: -32026,
  invalidParams: -32602,
  internal: -32603,
} as const;

/** The JSON-RPC error for a call failure of a subscription before its first occurrence. */
export function mcpSubscribeError(failure: CallFailure): { readonly code: number; readonly message: string; readonly data?: JsonObject } {
  if (failure.kind === "unknown-capability") return { code: MCP_EVENT_ERRORS.notFound, message: failure.message, data: { kind: "event" } };
  if (failure.kind === "invalid-input") return { code: MCP_EVENT_ERRORS.invalidParams, message: failure.message };
  return { code: MCP_EVENT_ERRORS.internal, message: failure.message };
}

/** An entry of `events/list`. `input` and `payload` are the bundled schemas. */
export function mcpEventEntry(id: string, description: string, input: JsonObject | undefined, payload: JsonObject | undefined): JsonObject {
  return {
    name: id,
    description,
    delivery: ["push"],
    inputSchema: input ?? { type: "object" },
    payloadSchema: payload ?? { type: "object" },
  };
}

/** The params of `notifications/events/event` for an occurrence: the occurrence without `truncated`. */
export function mcpEventParams(occurrence: Occurrence, subscriptionId: string | number): JsonObject {
  const { truncated: _, ...rest } = occurrence;
  return { ...rest, _meta: { [MCP_SUBSCRIPTION_ID]: subscriptionId } };
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

// ---------------------------------------------------------------------------------------------------------------
// Catalog (spec/catalog.md)
// ---------------------------------------------------------------------------------------------------------------

export type JsonObject = { readonly [key: string]: unknown };

export interface CatalogCapability extends JsonObject {
  readonly description: string;
  readonly audience?: readonly string[];
  readonly input?: JsonObject;
  readonly output?: JsonObject;
  readonly failures?: { readonly [tag: string]: JsonObject };
  readonly readOnly?: boolean;
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

/** Tell if a value is a JSON object: an object that is not `null` and not an array. */
export const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/** A value as a JSON object, or an empty object when it is not one. */
const objectOrEmpty = (value: unknown): JsonObject => (isJsonObject(value) ? value : {});

/** The strings in a value that is an array, or no strings when it is not an array. */
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

/** Every object in a JSON value, at all levels. */
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
      const name = typeof inner.$ref === "string" ? REFERENCE.exec(inner.$ref)?.[1] : undefined;
      const type = name === undefined ? undefined : types[name];
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
    const object = node;
    const name = typeof object.$ref === "string" ? REFERENCE.exec(object.$ref)?.[1] : undefined;
    return name === undefined ? object : types[name];
  };
  const target = resolve(schema);
  if (schema.type !== undefined || target === undefined || target.type !== undefined) return schema;
  const union = target.anyOf ?? target.oneOf;
  if (!Array.isArray(union) || union.length === 0) return schema;
  return union.every((member) => resolve(member)?.type === "object") ? { type: "object", ...schema } : schema;
}

/** Bundle a schema (spec/catalog.md#bundling). */
export function bundle(schema: JsonObject, types: { readonly [name: string]: JsonObject }): JsonObject {
  const only = Object.keys(schema).length === 1 ? REFERENCE.exec(String(schema.$ref))?.[1] : undefined;
  const base = only === undefined ? schema : (types[only] ?? schema);
  const used = typesUsedBy(base, types);
  return used.size === 0 ? base : { ...base, $defs: Object.fromEntries(used) };
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
  const declared = catalog.targets[target];
  return {
    ...rest,
    targets: declared === undefined ? {} : { [target]: declared },
    ...(used.size > 0 ? { $defs: Object.fromEntries(used) } : {}),
    capabilities,
    ...(Object.keys(events).length > 0 ? { events } : {}),
  };
}
