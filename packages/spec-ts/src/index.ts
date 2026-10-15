/**
 * The fixed details of the AcidCat specification, as TypeScript data and pure functions, for the TypeScript reference
 * implementation. This package has no dependencies.
 *
 * - Outcomes and call failures: spec/invocation.md
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

/** A failure with its tag, as a result. */
export const fail = <Tag extends string, Data extends object = {}>(
  tag: Tag,
  data?: Data,
): Result<never, { readonly _tag: Tag } & Data> => ({ ok: false, error: { _tag: tag, ...(data ?? ({} as Data)) } });

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
  const properties = (input.properties ?? {}) as { readonly [name: string]: JsonObject };
  const definitions = (input.$defs ?? {}) as { readonly [name: string]: JsonObject };
  const required = new Set((input.required ?? []) as readonly string[]);
  const byName = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  const names = Object.keys(properties).sort(byName);
  return [...names.filter((name) => required.has(name)), ...names.filter((name) => !required.has(name))].map((name) => {
    const reference = properties[name]!.$ref;
    const target = typeof reference === "string" ? REFERENCE.exec(reference)?.[1] : undefined;
    const property = (target === undefined ? undefined : definitions[target]) ?? properties[name]!;
    const flag = property.type === "boolean" ? `--${name}` : `--${name} <${flagValue(property)}>`;
    return required.has(name) ? flag : `[${flag}]`;
  });
}

function flagValue(property: JsonObject): string {
  if (Array.isArray(property.enum) && property.enum.every((value) => typeof value === "string")) return property.enum.join("|");
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
  const mediaType = (request.headers.get("Content-Type") ?? "").split(";")[0]!.trim().toLowerCase();
  if (mediaType !== rules.mediaType) return "media-type";
  const declared = Number(request.headers.get("Content-Length") ?? "");
  if (Number.isFinite(declared) && declared > rules.maximumBytes) return "too-large";
  return undefined;
}

/**
 * Read a request body as UTF-8 text. Count the bytes as they arrive, and stop at the limit. The signal of the request
 * stops the read: the body is cancelled, and the promise rejects with the reason of the signal.
 */
export async function readBounded(
  request: Request,
  maximumBytes: number,
): Promise<{ readonly text: string } | { readonly rejection: Rejection }> {
  if (request.body === null) return { text: "" };
  const signal = request.signal;
  signal.throwIfAborted();
  const reader = request.body.getReader();
  let onAbort: (() => void) | undefined;
  const aborted = new Promise<never>((_, reject) => {
    onAbort = () => {
      void reader.cancel(signal.reason).catch(() => undefined);
      reject(signal.reason);
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
  aborted.catch(() => undefined);
  const chunks: Uint8Array[] = [];
  let length = 0;
  try {
    for (;;) {
      const { done, value } = await Promise.race([reader.read(), aborted]);
      // A runtime can end the body of an aborted request as if it were complete.
      signal.throwIfAborted();
      if (done) break;
      length += value.byteLength;
      if (length > maximumBytes) {
        await reader.cancel().catch(() => undefined);
        return { rejection: "too-large" };
      }
      chunks.push(value);
    }
  } finally {
    signal.removeEventListener("abort", onAbort!);
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

export interface CatalogDocument extends JsonObject {
  readonly acidcat: string;
  readonly title?: string;
  readonly description?: string;
  readonly targets: { readonly [name: string]: JsonObject & { readonly bindings: readonly string[] } };
  readonly $defs?: { readonly [name: string]: JsonObject };
  readonly capabilities: { readonly [id: string]: CatalogCapability };
}

export const REFERENCE = /^#\/\$defs\/([A-Za-z][A-Za-z0-9_]*)$/;

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

/** Every object in a JSON value, at all levels. */
export function visitObjects(value: unknown, onObject: (node: JsonObject) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visitObjects(item, onObject));
  } else if (value !== null && typeof value === "object") {
    onObject(value as JsonObject);
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
  const used = new Map<string, JsonObject>();
  for (const capability of Object.values(capabilities)) {
    for (const [, schema] of schemasOf(capability)) for (const [name, type] of typesUsedBy(schema, types)) used.set(name, type);
  }
  const { $defs: _, ...rest } = catalog;
  const declared = catalog.targets[target];
  return {
    ...rest,
    targets: declared === undefined ? {} : { [target]: declared },
    ...(used.size > 0 ? { $defs: Object.fromEntries(used) } : {}),
    capabilities,
  };
}
