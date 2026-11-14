/**
 * The MCP binding (spec/bindings/mcp.md): an MCP server through HTTP, revision 2026-07-28. The server keeps no state
 * between requests, except poll leases and webhook subscriptions.
 */
import { bundle, isJsonObject, KEEPALIVE_MS, MCP_PROTOCOL_VERSION, MCP_REJECTIONS, MCP_UNKNOWN_TOOL, mcpToolResult, readBounded, screenRequest, SSE_MEDIA_TYPE, sseMessage } from "@acid-cat/spec-ts";
import type { JsonObject, Rejection } from "@acid-cat/spec-ts";

import type { App, ToJsonSchema } from "./app.ts";
import { openContext, refusalResponse } from "./context.ts";
import type { ContextOption } from "./context.ts";
import type { Clock } from "./clock.ts";
import { eventCapabilities, forbidden, listEvents, servesEvents, startEventStream, unsupportedWebhook } from "./mcp-events.ts";
import type { OpenSession, RpcAnswer, WebhookDelivery } from "./mcp-events.ts";
import { PollLeases } from "./mcp-poll.ts";
import type { PollOptions } from "./mcp-poll.ts";
import { createSession } from "./session.ts";
import type { Session } from "./session.ts";
import { textStream } from "./stream.ts";

/** The options of `mcpHandler`. Give `context` to share one context, or `createContext` to make one for each request. */
export type McpOptions<Context> = McpSettings & ContextOption<Context>;

export interface McpSettings {
  readonly name: string;
  readonly version: string;
  /**
   * Guidance for a model about the whole server, which `server/discover` gives as `instructions`. The default is the
   * description of the application.
   */
  readonly instructions?: string | undefined;
  /** The origins that can call the server. A request with no `Origin` header is accepted. */
  readonly allowedOrigins: readonly string[];
  readonly toJsonSchema: ToJsonSchema;
  /** The target that the server serves. The default is `"mcp"`. */
  readonly target?: string | undefined;
  /** The maximum size of a request body, in bytes. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
  /** The time with nothing sent on an `events/stream` response after which the server sends a heartbeat, in milliseconds. The default is 15 seconds. */
  readonly heartbeatMs?: number | undefined;
  /** The number of occurrences that each subscription keeps for a client that reads slowly. The default is 256. */
  readonly bufferLimit?: number | undefined;
  /**
   * The identity of the client of a request: the principal (spec/bindings/mcp.md#webhook). It is part of the key of a
   * poll lease and of a webhook subscription. `undefined` means that the request has no identity. With no function, no
   * request has an identity.
   */
  readonly principal?: ((request: Request) => string | undefined | Promise<string | undefined>) | undefined;
  /** The settings of poll delivery: the lease time, the size of the buffer, `maxEvents` and `nextPollMs`. */
  readonly poll?: PollOptions | undefined;
  /**
   * Webhook delivery. It is off when this member is absent. `webhookDelivery` of `@acid-cat/core-ts/node` makes it.
   * A request to `events/subscribe` or `events/unsubscribe` with no principal gets `Forbidden`.
   */
  readonly webhooks?: WebhookDelivery | undefined;
  /** The clock of the poll leases. The default is the clock of the system. Tests give a clock that they control. */
  readonly clock?: Clock | undefined;
}

/**
 * The web request handler of an MCP server through HTTP. `close` ends the poll leases and the webhook subscriptions.
 * `await using` calls it at the end of its block.
 */
export interface McpHandler {
  (request: Request): Promise<Response>;
  readonly close: () => Promise<void>;
  readonly [Symbol.asyncDispose]: () => Promise<void>;
}

/** The members of a JSON-RPC request that the server reads. A request with no `id` is a notification. */
interface JsonRpcRequest {
  readonly id?: string | number | null;
  readonly method?: string | undefined;
  readonly name?: string | undefined;
  readonly arguments?: unknown;
  readonly params: JsonObject;
  readonly protocolVersion?: unknown;
}

/**
 * Read the members of a JSON-RPC request from a parsed body. A member that does not have its type is left out. An
 * `id` that is not a string or a number is `null`.
 */
function readRequest(body: unknown): JsonRpcRequest {
  if (!isJsonObject(body)) return { params: {} };
  const { id, method, params } = body;
  const meta = isJsonObject(params) ? params["_meta"] : undefined;
  return {
    ...("id" in body ? { id: typeof id === "string" || typeof id === "number" ? id : null } : {}),
    method: typeof method === "string" ? method : undefined,
    name: isJsonObject(params) && typeof params["name"] === "string" ? params["name"] : undefined,
    arguments: isJsonObject(params) ? params["arguments"] : undefined,
    params: isJsonObject(params) ? params : {},
    protocolVersion: isJsonObject(meta) ? meta["io.modelcontextprotocol/protocolVersion"] : undefined,
  };
}

/**
 * A web request handler for the MCP server. Each request has its own session, and with `createContext` its own
 * context. `createContext` can refuse a request: then the handler answers with the refusal, and opens no session.
 * Each poll lease and each webhook subscription also has its own session, with the context of the request that
 * started it. The handler releases that context when the answer is done and each of those leases and subscriptions
 * has ended.
 */
export function mcpHandler<Context>(app: App<Context>, options: McpOptions<Context>): McpHandler {
  const maximumBytes = options.maximumBytes ?? 1_048_576;
  const leases = new PollLeases(options.poll, options.clock);
  const closeAll = async () => {
    await Promise.allSettled([leases.close(), options.webhooks?.close()]);
  };
  const handle = async (request: Request): Promise<Response> => {
    const screened = screenRequest(request, {
      methods: ["POST"],
      allowedOrigins: options.allowedOrigins,
      mediaType: "application/json",
      maximumBytes,
    });
    if (screened !== undefined) return rejection(screened);
    const body = await readBounded(request, maximumBytes);
    if ("rejection" in body) return rejection(body.rejection);
    let message: JsonRpcRequest;
    try {
      message = readRequest(JSON.parse(body.text));
    } catch {
      return rejection("not-utf8");
    }

    // The context of the request. `createContext` can refuse the request here, before a session opens.
    const opened = await openContext<Context>(options, request);
    if ("refusal" in opened) return refusalResponse(opened.refusal);
    const unanswerable = revisionError(request, message);
    if (unanswerable !== undefined) {
      await opened.release();
      return unanswerable;
    }
    const id = message.id ?? null;

    // The session of the request uses the context of the request. A poll lease or a webhook subscription that the
    // request starts opens one more session, with the same context. Each open session holds the context. The last
    // session to close releases it: the context lives until the answer is done and every lease and webhook
    // subscription of the request has ended.
    let holders = 0;
    const open: OpenSession = async () => {
      holders += 1;
      const session = createSession(app, {
        target: options.target ?? "mcp",
        context: opened.context,
        toJsonSchema: options.toJsonSchema,
        ...(options.bufferLimit === undefined ? {} : { bufferLimit: options.bufferLimit }),
      });
      let closing: Promise<void> | undefined;
      const close = () =>
        (closing ??= (async () => {
          try {
            await session.dispose();
          } finally {
            holders -= 1;
            if (holders === 0) await opened.release();
          }
        })());
      return { session, close };
    };
    const { session, close } = await open();
    // The stream of `events/stream` closes the session and releases the context when it ends.
    let streaming = false;
    try {
      if (message.method === "events/stream" && message.id !== null && message.id !== undefined && servesEvents(session)) {
        const started = await startEventStream(session, message.id, message.params, {
          heartbeatMs: options.heartbeatMs ?? KEEPALIVE_MS,
          resultMeta: serverInfoOf(options),
          signal: request.signal,
        });
        if ("error" in started) return error(200, id, started.error.code, started.error.message, started.error.data);
        const { messages, cancel } = started;
        const produce = async () => (await messages())?.map((each) => sseMessage({ data: JSON.stringify(each) }));
        const body = textStream(produce, cancel, close);
        streaming = true;
        return new Response(body, { status: 200, headers: { "Content-Type": SSE_MEDIA_TYPE, "Cache-Control": "no-store" } });
      }
      if (servesEvents(session) && message.method !== undefined && LONG_LIVED.has(message.method)) {
        const principal = await options.principal?.(request);
        const answered = await longLived(message.method, message.params, principal, open, leases, options.webhooks);
        if ("error" in answered) return error(200, id, answered.error.code, answered.error.message, answered.error.data);
        return reply(id, { _meta: serverInfoOf(options), resultType: "complete", ...answered.result });
      }
      return await answer(session, message, { ...options, instructions: options.instructions ?? app.description }, request.signal);
    } finally {
      if (!streaming) await close();
    }
  };
  return Object.assign(handle, { close: closeAll, [Symbol.asyncDispose]: closeAll });
}

/**
 * The error answer of a request that does not name revision 2026-07-28 correctly, or the empty answer of a
 * notification. `undefined` for a request that the server answers.
 */
function revisionError(request: Request, message: JsonRpcRequest): Response | undefined {
  // Revision 2026-07-28: each request names its revision in a header, and each request repeats it in `_meta`.
  const version = request.headers.get("MCP-Protocol-Version");
  const id = message.id ?? null;
  if (version === null) return error(400, id, -32020, "MCP-Protocol-Version header is required");
  if (version !== MCP_PROTOCOL_VERSION) {
    return error(400, id, -32022, `Unsupported protocol version ${version}`, { supported: [MCP_PROTOCOL_VERSION] });
  }
  if (message.id === undefined) return new Response(null, { status: 200, headers: { "Content-Type": "application/json" } });
  const metaVersion = message.protocolVersion;
  if (metaVersion === undefined) return error(400, id, -32602, "Required request metadata is missing");
  if (metaVersion !== version) return error(400, id, -32020, "MCP-Protocol-Version header does not match request metadata");
  return undefined;
}

/** The methods whose state outlives the request (spec/bindings/mcp.md#subscriptions-that-outlive-a-request). */
const LONG_LIVED: ReadonlySet<string> = new Set(["events/poll", "events/subscribe", "events/unsubscribe"]);

/** Answer `events/poll`, `events/subscribe` or `events/unsubscribe`. */
async function longLived(method: string, params: JsonObject, principal: string | undefined, open: OpenSession, leases: PollLeases, webhooks: WebhookDelivery | undefined): Promise<RpcAnswer> {
  if (method === "events/poll") return leases.poll(principal, params, open);
  if (webhooks === undefined) return { error: unsupportedWebhook };
  if (principal === undefined) return { error: forbidden };
  return method === "events/subscribe" ? webhooks.subscribe(principal, params, open) : webhooks.unsubscribe(principal, params);
}

/** The `_meta` of a result: the information about the server. */
const serverInfoOf = (options: McpSettings): JsonObject => ({ "io.modelcontextprotocol/serverInfo": { name: options.name, version: options.version } });

async function answer(session: Session, message: JsonRpcRequest, options: McpSettings, signal: AbortSignal): Promise<Response> {
  const id = message.id ?? null;
  const complete = (result: object, list = false) =>
    reply(id, {
      _meta: serverInfoOf(options),
      resultType: "complete",
      ...(list ? { ttlMs: 0, cacheScope: "private" } : {}),
      ...result,
    });
  switch (message.method) {
    case "server/discover":
      return complete(
        {
          supportedVersions: [MCP_PROTOCOL_VERSION],
          capabilities: { tools: { listChanged: false }, ...eventCapabilities(session) },
          ...(options.instructions === undefined ? {} : { instructions: options.instructions }),
        },
        true,
      );
    case "tools/list":
      return complete({ tools: listTools(session) }, true);
    case "tools/call": {
      const name = message.name ?? "";
      const handle = session.handles.get(name);
      if (handle === undefined || !handle.availability.getSnapshot().available) {
        return error(200, id, MCP_UNKNOWN_TOOL, `Tool '${name}' not found`);
      }
      const outcome = await session.invoke(name, message.arguments ?? {}, { signal });
      return complete(mcpToolResult(outcome, hasObjectOutput(session, name)));
    }
    case "events/list":
      if (!servesEvents(session)) break;
      return complete({ events: listEvents(session, options.webhooks !== undefined) }, true);
  }
  return error(404, id, -32601, `Method not found: ${message.method}`);
}

/** The tools of the available capabilities in the view of a session (spec/bindings/mcp.md#tools). */
export function listTools(session: Session) {
  const types = session.view.$defs ?? {};
  return [...session.handles.values()]
    .filter((handle) => handle.availability.getSnapshot().available)
    .map((handle) => {
      const capability = session.view.capabilities[handle.id];
      if (capability === undefined) throw new Error(`The view of the session has no capability ${handle.id}.`);
      const output = capability.output === undefined ? undefined : bundle(capability.output, types);
      return {
        name: handle.id,
        description: capability.description,
        inputSchema: bundle(capability.input ?? { type: "object" }, types),
        ...(output?.type === "object" ? { outputSchema: output } : {}),
        annotations: { readOnlyHint: capability.readOnly === true },
      };
    });
}

/** True if the bundled output schema of a capability has `"type": "object"`. */
export function hasObjectOutput(session: Session, id: string): boolean {
  const output = session.view.capabilities[id]?.output;
  return output !== undefined && bundle(output, session.view.$defs ?? {}).type === "object";
}

function reply(id: string | number | null, result: object): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, result }), { status: 200, headers: { "Content-Type": "application/json" } });
}

function error(status: number, id: string | number | null, code: number, message: string, data?: object): Response {
  const body = { jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } };
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

function rejection(reason: Rejection): Response {
  const { status, code } = MCP_REJECTIONS[reason];
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (reason === "method") headers.set("Allow", "POST");
  if (code === undefined) return new Response(null, { status, headers });
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify({ jsonrpc: "2.0", id: null, error: { code, message: messages[reason] } }), { status, headers });
}

const messages: { readonly [R in Rejection]: string } = {
  method: "Use POST.",
  origin: "This origin is not allowed.",
  "media-type": "Use application/json.",
  "too-large": "The request body is too large.",
  "not-utf8": "The request body is not UTF-8 JSON.",
};
