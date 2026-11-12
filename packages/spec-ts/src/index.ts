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
  const resume = "[--cursor <string>] [--max-age-ms <integer>]";
  if (input !== undefined && input.properties === undefined) return `${program} watch ${id} '<json>' ${resume}`;
  return [program, "watch", id, ...(input === undefined ? [] : cliFlags(input)), resume].join(" ");
}

/** The flags of `watch` that give the cursor and `maxAgeMs`. No input property of an event can have these names. */
export const CLI_RESUME_FLAGS = ["cursor", "max-age-ms"] as const;

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
  forbidden: -32024,
  resourceExhausted: -32025,
  unsupported: -32026,
  callbackEndpoint: -32027,
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

/** The position of a poll cursor, or `undefined` when the text is not a poll cursor. */
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
  const [a = 0, b = 0, c = 0, d = 0, e = 0, f = 0, g = 0, h = 0] = ipv6;
  // IPv4-mapped (::ffff:a.b.c.d): check the IPv4 address.
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0xffff) return isGlobalIpv4([g >> 8, g & 255, h >> 8, h & 255]);
  if (ipv6.every((word) => word === 0)) return false; // ::
  if (a === 0 && b === 0 && c === 0 && d === 0 && e === 0 && f === 0 && g === 0 && h === 1) return false; // ::1
  if (a === 0x64 && b === 0xff9b) return false; // 64:ff9b::/96 and 64:ff9b:1::/48
  if (a === 0x100 && b === 0 && c === 0 && d === 0) return false; // 100::/64
  if (a === 0x2001 && b < 0x200) return false; // 2001::/23
  if (a === 0x2001 && b === 0xdb8) return false; // 2001:db8::/32
  if (a === 0x2002) return false; // 2002::/16
  if (a === 0x3fff && b < 0x1000) return false; // 3fff::/20
  if (a === 0x5f00) return false; // 5f00::/16
  if ((a & 0xfe00) === 0xfc00) return false; // fc00::/7
  if ((a & 0xffc0) === 0xfe80) return false; // fe80::/10
  if ((a & 0xff00) === 0xff00) return false; // ff00::/8
  return (a & 0xe000) === 0x2000; // 2000::/3 is the global unicast range.
}

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

function ipv6Words(input: string): number[] | undefined {
  let address = input.startsWith("[") && input.endsWith("]") ? input.slice(1, -1) : input;
  const zone = address.indexOf("%");
  if (zone !== -1) address = address.slice(0, zone);
  const tail: number[] = [];
  const lastColon = address.lastIndexOf(":");
  const ipv4 = lastColon === -1 ? undefined : ipv4Bytes(address.slice(lastColon + 1));
  if (ipv4 !== undefined) {
    const [w = 0, x = 0, y = 0, z = 0] = ipv4;
    tail.push((w << 8) | x, (y << 8) | z);
    // Keep the "::" before an embedded IPv4 address, and remove a single ":".
    address = address.slice(0, lastColon + 1);
    if (!address.endsWith("::")) address = address.slice(0, -1);
  }
  const halves = address.split("::");
  if (halves.length > 2) return undefined;
  const words = (text: string) => (text === "" ? [] : text.split(":"));
  const head = words(halves[0] ?? "");
  const rest = halves.length === 2 ? words(halves[1] ?? "") : [];
  if (![...head, ...rest].every((word) => /^[0-9a-fA-F]{1,4}$/.test(word))) return undefined;
  const count = head.length + rest.length + tail.length;
  if (halves.length === 1 ? count !== 8 : count > 7) return undefined;
  const zeros = halves.length === 2 ? Array.from({ length: 8 - count }, () => 0) : [];
  return [...head.map((word) => parseInt(word, 16)), ...zeros, ...rest.map((word) => parseInt(word, 16)), ...tail];
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

/** The name of the type that a schema's `$ref` refers to, or `undefined` when it has no `$ref` of that form. */
const referenceName = (schema: JsonObject): string | undefined =>
  typeof schema.$ref === "string" ? REFERENCE.exec(schema.$ref)?.[1] : undefined;

/** Tell if a value is a JSON object: an object that is not `null` and not an array. */
export const isJsonObject = (value: unknown): value is JsonObject => typeof value === "object" && value !== null && !Array.isArray(value);

/**
 * The member of an object with this key, or `undefined` when the object does not have it. Inherited names, such as
 * `constructor` or `toString`, are not members.
 */
export function ownMember<Value>(object: { readonly [key: string]: Value }, key: string): Value | undefined {
  return Object.hasOwn(object, key) ? object[key] : undefined;
}

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
