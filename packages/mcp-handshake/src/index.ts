/**
 * The `initialize` handshake of earlier MCP revisions through HTTP (spec/bindings/mcp.md#earlier-revisions-through-http).
 * `mcpHandshake` wraps the web handler of an MCP server that serves revision 2026-07-28. Each request of a revision with
 * a handshake goes to that handler as a request of revision 2026-07-28, so the handler screens it. The wrapper keeps no
 * state.
 */
import {
  isJsonObject,
  isMcpHandshakeRequest,
  MCP_PROTOCOL_VERSION,
  mcpHandshakeResult,
  mcpInitializeResult,
  readBounded,
} from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

/** A web request handler. */
export type WebHandler = (request: Request) => Promise<Response>;

export interface McpHandshakeOptions {
  /** The maximum size of a request body, in bytes. Give the limit of the wrapped handler. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
}

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

/**
 * A web handler that serves the `initialize` handshake of revisions 2025-11-25 and 2025-06-18, and gives all other
 * requests to `handler` unchanged.
 */
export function mcpHandshake(handler: WebHandler, options: McpHandshakeOptions = {}): WebHandler {
  const maximumBytes = options.maximumBytes ?? 1_048_576;
  return async (request) => {
    const header = request.headers.get("MCP-Protocol-Version");
    if (request.method !== "POST" || header === MCP_PROTOCOL_VERSION) return handler(request);
    const message = await readMessage(request.clone(), maximumBytes);
    // A body that is too large or not a JSON object goes to the handler, which rejects it.
    if (message === undefined || !isMcpHandshakeRequest(header, metaOf(message)[PROTOCOL_VERSION_KEY])) return handler(request);
    return answer(handler, request, message);
  };
}

/**
 * Answer a request of a revision with a handshake. `initialize`, `ping` and notifications go to the handler as
 * `server/discover`, and the other methods go as they are.
 */
async function answer(handler: WebHandler, request: Request, message: JsonObject): Promise<Response> {
  const method = typeof message["method"] === "string" ? message["method"] : "";
  const params = isJsonObject(message["params"]) ? message["params"] : {};
  const ownMethod = method === "tools/list" || method === "tools/call" ? method : "server/discover";
  const response = await handler(current(request, ownMethod, ownMethod === "server/discover" ? {} : params));
  // A rejection of the handler, for example of the origin, goes to the client unchanged.
  if (!response.ok) return response;
  const reply = parseObject(await response.text()) ?? {};
  if (!("id" in message)) return new Response(null, { status: 202 });
  const id = message["id"];
  const result = reply["result"];
  if (!isJsonObject(result)) return json({ jsonrpc: "2.0", id, error: reply["error"] ?? { code: -32603, message: "The server gave no result." } });
  if (method === "initialize") return json({ jsonrpc: "2.0", id, result: initializeResult(params["protocolVersion"], result) });
  if (method === "ping") return json({ jsonrpc: "2.0", id, result: {} });
  if (ownMethod === "server/discover") return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  return json({ jsonrpc: "2.0", id, result: mcpHandshakeResult(result) });
}

/** The request of revision 2026-07-28 for `method`, with the headers and the metadata that the revision requires. */
function current(request: Request, method: string, params: JsonObject): Request {
  const headers = new Headers(request.headers);
  headers.set("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
  headers.set("Mcp-Method", method);
  headers.set("Accept", "application/json, text/event-stream");
  if (method === "tools/call" && typeof params["name"] === "string") headers.set("Mcp-Name", params["name"]);
  const meta = { ...metaOf({ params }), [PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_KEY]: {} };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 0, method, params: { ...params, _meta: meta } });
  return new Request(request.url, { method: "POST", headers, body, signal: request.signal });
}

/**
 * The result of `initialize`, from the result of `server/discover`. The wrapper keeps no session, so it cannot send
 * `notifications/tools/list_changed`.
 */
function initializeResult(offered: unknown, discovered: JsonObject): JsonObject {
  const info = metaOf({ params: discovered })[SERVER_INFO_KEY];
  const name = isJsonObject(info) && typeof info["name"] === "string" ? info["name"] : "";
  const version = isJsonObject(info) && typeof info["version"] === "string" ? info["version"] : "";
  const instructions = typeof discovered["instructions"] === "string" ? discovered["instructions"] : undefined;
  const capabilities = isJsonObject(discovered["capabilities"]) ? discovered["capabilities"] : {};
  return mcpInitializeResult(offered, { name, version, instructions }, { ...capabilities, tools: { listChanged: false } });
}

/** The `params._meta` of a message, or an empty object. */
function metaOf(message: JsonObject): JsonObject {
  const params = message["params"];
  const meta = isJsonObject(params) ? params["_meta"] : undefined;
  return isJsonObject(meta) ? meta : {};
}

/** The JSON object in the body of a request, or `undefined` when the body is too large or not a JSON object. */
async function readMessage(request: Request, maximumBytes: number): Promise<JsonObject | undefined> {
  const body = await readBounded(request, maximumBytes);
  return "text" in body ? parseObject(body.text) : undefined;
}

function parseObject(text: string): JsonObject | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isJsonObject(value) ? value : undefined;
  } catch {
    return undefined;
  }
}

const json = (body: JsonObject) => new Response(JSON.stringify(body), { status: 200, headers: { "Content-Type": "application/json" } });
