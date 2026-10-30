/**
 * The MCP binding (spec/bindings/mcp.md): an MCP server through HTTP, with no state on the server between requests. The
 * server serves revision 2026-07-28, and the `initialize` handshake of revisions 2025-11-25 and 2025-06-18.
 */
import {
  bundle,
  isJsonObject,
  MCP_PROTOCOL_VERSION,
  MCP_REJECTIONS,
  MCP_UNKNOWN_TOOL,
  mcpHandshakeResult,
  mcpHttpRevision,
  mcpInitializeResult,
  mcpToolResult,
  readBounded,
  screenRequest,
} from "@acid-cat/spec-ts";
import type { JsonObject, Rejection } from "@acid-cat/spec-ts";

import type { App, ToJsonSchema } from "./app.ts";
import { withContext } from "./context.ts";
import type { ContextOption } from "./context.ts";
import { createSession } from "./session.ts";
import type { Session } from "./session.ts";

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
}

/** The members of a JSON-RPC request that the server reads. A request with no `id` is a notification. */
interface JsonRpcRequest {
  readonly id?: string | number | null;
  readonly method?: string | undefined;
  readonly name?: string | undefined;
  readonly arguments?: unknown;
  readonly protocolVersion?: unknown;
  /** The revision that the client offers in `initialize`. */
  readonly offeredVersion?: unknown;
}

/**
 * Read the members of a JSON-RPC request from a parsed body. A member that does not have its type is left out. An
 * `id` that is not a string or a number is `null`.
 */
function readRequest(body: unknown): JsonRpcRequest {
  if (!isJsonObject(body)) return {};
  const { id, method, params } = body;
  const meta = isJsonObject(params) ? params["_meta"] : undefined;
  return {
    ...("id" in body ? { id: typeof id === "string" || typeof id === "number" ? id : null } : {}),
    method: typeof method === "string" ? method : undefined,
    name: isJsonObject(params) && typeof params["name"] === "string" ? params["name"] : undefined,
    arguments: isJsonObject(params) ? params["arguments"] : undefined,
    protocolVersion: isJsonObject(meta) ? meta["io.modelcontextprotocol/protocolVersion"] : undefined,
    offeredVersion: isJsonObject(params) ? params["protocolVersion"] : undefined,
  };
}

/** A web request handler for the MCP server. Each request has its own session, and with `createContext` its own context. */
export function mcpHandler<Context>(app: App<Context>, options: McpOptions<Context>) {
  const maximumBytes = options.maximumBytes ?? 1_048_576;
  return async (request: Request): Promise<Response> => {
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

    // Revision 2026-07-28 names its revision in a header and in `_meta`. A client of an earlier revision opens the
    // session with `initialize`, and the server keeps no state for it.
    const id = message.id ?? null;
    const revision = mcpHttpRevision(request.headers.get("MCP-Protocol-Version"), message.protocolVersion);
    if (revision.revision === "rejected") return error(400, id, revision.code, revision.message, revision.data);
    const current = revision.revision === "current";
    const settings = { ...options, instructions: options.instructions ?? app.description };
    if (message.id === undefined) {
      return current ? new Response(null, { status: 200, headers: { "Content-Type": "application/json" } }) : new Response(null, { status: 202 });
    }
    if (!current && message.method === "initialize") return reply(id, mcpInitializeResult(message.offeredVersion, settings, CAPABILITIES));
    if (!current && message.method === "ping") return reply(id, {});

    return withContext<Context, Response>(options, request, async (context) => {
      const session = createSession(app, { target: options.target ?? "mcp", context, toJsonSchema: options.toJsonSchema });
      try {
        return await answer(session, message, settings, current, request.signal);
      } finally {
        await session.dispose();
      }
    });
  };
}

/** The capabilities of the server. Through HTTP, the server keeps no session, so it sends no changes of the tools. */
const CAPABILITIES = { tools: { listChanged: false } };

/**
 * Answer a request in a session. With `current`, the request is of revision 2026-07-28. Without it, the request is of
 * a revision with a handshake: its results have no members of revision 2026-07-28, and its errors have the status 200.
 */
async function answer(session: Session, message: JsonRpcRequest, options: McpSettings, current: boolean, signal: AbortSignal): Promise<Response> {
  const id = message.id ?? null;
  const complete = (result: JsonObject, list = false) => {
    const full = {
      _meta: { "io.modelcontextprotocol/serverInfo": { name: options.name, version: options.version } },
      resultType: "complete",
      ...(list ? { ttlMs: 0, cacheScope: "private" } : {}),
      ...result,
    };
    return reply(id, current ? full : mcpHandshakeResult(full));
  };
  const failure = (status: number, code: number, text: string) => error(current ? status : 200, id, code, text);
  switch (message.method) {
    case "server/discover":
      if (!current) return failure(404, -32601, `Method not found: ${message.method}`);
      return complete(
        {
          supportedVersions: [MCP_PROTOCOL_VERSION],
          capabilities: CAPABILITIES,
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
        return failure(200, MCP_UNKNOWN_TOOL, `Tool '${name}' not found`);
      }
      const outcome = await session.invoke(name, message.arguments ?? {}, { signal });
      return complete({ ...mcpToolResult(outcome, hasObjectOutput(session, name)) });
    }
    default:
      return failure(404, -32601, `Method not found: ${message.method}`);
  }
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
