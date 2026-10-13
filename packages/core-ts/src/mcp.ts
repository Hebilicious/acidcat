/**
 * The MCP binding (spec/bindings/mcp.md): an MCP server through HTTP, revision 2026-07-28, with no state on the
 * server between requests.
 */
import { bundle, MCP_PROTOCOL_VERSION, MCP_REJECTIONS, MCP_UNKNOWN_TOOL, mcpToolResult, readBounded, screenRequest } from "@acid-cat/spec";
import type { Rejection } from "@acid-cat/spec";

import type { App, ToJsonSchema } from "./app.ts";
import { createSession } from "./session.ts";
import type { Session } from "./session.ts";

export interface McpOptions<Context> {
  readonly name: string;
  readonly version: string;
  /** The origins that can call the server. A request with no `Origin` header is accepted. */
  readonly allowedOrigins: readonly string[];
  readonly context: Context;
  readonly toJsonSchema: ToJsonSchema;
  /** The target that the server serves. The default is `"mcp"`. */
  readonly target?: string | undefined;
  /** The maximum size of a request body, in bytes. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
}

interface JsonRpcRequest {
  readonly jsonrpc: "2.0";
  readonly id?: string | number | null;
  readonly method: string;
  readonly params?: { readonly name?: string; readonly arguments?: unknown };
}

/** A web request handler for the MCP server. Each request has its own session. */
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
      message = JSON.parse(body.text) as JsonRpcRequest;
    } catch {
      return rejection("not-utf8");
    }
    if (message.id === undefined) return new Response(null, { status: 202 });

    const session = createSession(app, {
      target: options.target ?? "mcp",
      context: options.context,
      toJsonSchema: options.toJsonSchema,
    });
    try {
      return reply(message.id, await answer(session, message, options, request.signal));
    } finally {
      await session.dispose();
    }
  };
}

type Answer = { readonly result: unknown } | { readonly error: { readonly code: number; readonly message: string } };

async function answer<Context>(session: Session, message: JsonRpcRequest, options: McpOptions<Context>, signal: AbortSignal): Promise<Answer> {
  switch (message.method) {
    case "initialize":
      return {
        result: {
          protocolVersion: MCP_PROTOCOL_VERSION,
          capabilities: { tools: { listChanged: false } },
          serverInfo: { name: options.name, version: options.version },
        },
      };
    case "ping":
      return { result: {} };
    case "tools/list":
      return { result: { tools: listTools(session) } };
    case "tools/call": {
      const name = message.params?.name ?? "";
      const handle = session.handles.get(name);
      if (handle === undefined || !handle.availability.getSnapshot().available) {
        return { error: { code: MCP_UNKNOWN_TOOL, message: `Tool '${name}' not found` } };
      }
      const outcome = await session.invoke(name, message.params?.arguments ?? {}, { signal });
      return { result: mcpToolResult(outcome, hasObjectOutput(session, name)) };
    }
    default:
      return { error: { code: -32601, message: `Method '${message.method}' not found` } };
  }
}

function listTools(session: Session) {
  const types = session.view.$defs ?? {};
  return [...session.handles.values()]
    .filter((handle) => handle.availability.getSnapshot().available)
    .map((handle) => {
      const capability = session.view.capabilities[handle.id]!;
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

function hasObjectOutput(session: Session, id: string): boolean {
  const output = session.view.capabilities[id]?.output;
  return output !== undefined && bundle(output, session.view.$defs ?? {}).type === "object";
}

function reply(id: string | number | null, answer: Answer): Response {
  return new Response(JSON.stringify({ jsonrpc: "2.0", id, ...answer }), { status: 200, headers: { "Content-Type": "application/json" } });
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
