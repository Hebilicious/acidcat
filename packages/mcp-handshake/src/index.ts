/** The `initialize` handshake of earlier MCP revisions through HTTP (spec/bindings/mcp.md#earlier-revisions-through-http). */
import { encodeMcpHeaderValue, isJsonObject, MCP_EVENTS_EXTENSION, MCP_PROTOCOL_VERSION, MCP_SERVER_CARD_MEDIA_TYPE, mcpParamHeaders, mcpServerCardResponse, mcpServerUrlOfCardRequest, readBounded } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

export type WebHandler = (request: Request) => Promise<Response>;

export interface McpHandshakeOptions {
  /** The maximum size of a request body, in bytes. Give the limit of the wrapped handler. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
}

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";
const SERVER_INFO_KEY = "io.modelcontextprotocol/serverInfo";

const HANDSHAKE_VERSIONS = ["2025-11-25", "2025-06-18"] as const;
const [LATEST_HANDSHAKE_VERSION] = HANDSHAKE_VERSIONS;

const CURRENT_ONLY_MEMBERS = new Set(["_meta", "resultType", "ttlMs", "cacheScope"]);

/**
 * A web handler that serves the `initialize` handshake of revisions 2025-11-25 and 2025-06-18, and gives all other
 * requests to `handler`. It adds these revisions to the `supportedProtocolVersions` of the Server Card of `handler`
 * (spec/bindings/mcp.md#server-card).
 */
export function mcpHandshake(handler: WebHandler, options: McpHandshakeOptions = {}): WebHandler {
  const maximumBytes = options.maximumBytes ?? 1_048_576;
  return async (request) => {
    if (request.method === "GET" && mcpServerUrlOfCardRequest(request) !== undefined) return cardWithHandshake(handler, request);
    const header = request.headers.get("MCP-Protocol-Version");
    if (request.method !== "POST" || header === MCP_PROTOCOL_VERSION) return handler(request);
    const message = await readMessage(request.clone(), maximumBytes);
    if (message === undefined || !isHandshakeRequest(header, metaOf(message)[PROTOCOL_VERSION_KEY])) return handler(request);
    return answer(handler, request, message);
  };
}

async function answer(handler: WebHandler, request: Request, message: JsonObject): Promise<Response> {
  const method = typeof message["method"] === "string" ? message["method"] : "";
  const params = isJsonObject(message["params"]) ? message["params"] : {};
  const ownMethod = method === "tools/list" || method === "tools/call" ? method : "server/discover";
  const paramHeaders = ownMethod === "tools/call" ? mcpParamHeaders(await inputSchemaOf(handler, request, params["name"]), params["arguments"]) : {};
  const response = await handler(asCurrentRevisionRequest(request, ownMethod, ownMethod === "server/discover" ? {} : params, paramHeaders));
  if (!response.ok) return response;
  const reply = parseObject(await response.text()) ?? {};
  if (!("id" in message)) return new Response(null, { status: 202 });
  const id = message["id"];
  const result = reply["result"];
  if (!isJsonObject(result)) return json({ jsonrpc: "2.0", id, error: reply["error"] ?? { code: -32603, message: "The server gave no result." } });
  if (method === "initialize") return json({ jsonrpc: "2.0", id, result: initializeResult(params["protocolVersion"], result) });
  if (method === "ping") return json({ jsonrpc: "2.0", id, result: {} });
  if (ownMethod === "server/discover") return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${method}` } });
  return json({ jsonrpc: "2.0", id, result: Object.fromEntries(Object.entries(result).filter(([member]) => !CURRENT_ONLY_MEMBERS.has(member))) });
}

async function cardWithHandshake(handler: WebHandler, request: Request): Promise<Response> {
  const headers = new Headers(request.headers);
  headers.delete("If-None-Match");
  const response = await handler(new Request(request.url, { method: "GET", headers, signal: request.signal }));
  if (response.status !== 200 || response.headers.get("Content-Type") !== MCP_SERVER_CARD_MEDIA_TYPE) return response;
  const card = parseObject(await response.text());
  if (card === undefined) return new Response(null, { status: 502 });
  const remotes = Array.isArray(card["remotes"]) ? card["remotes"].map((remote: unknown) => (isJsonObject(remote) ? withHandshakeVersions(remote) : remote)) : card["remotes"];
  return mcpServerCardResponse(request, { ...card, remotes });
}

function withHandshakeVersions(remote: JsonObject): JsonObject {
  const listed: unknown = remote["supportedProtocolVersions"];
  const versions: readonly unknown[] = Array.isArray(listed) ? listed : [];
  return { ...remote, supportedProtocolVersions: [...versions, ...HANDSHAKE_VERSIONS.filter((version) => !versions.includes(version))] };
}

function isHandshakeRequest(header: string | null, metaVersion: unknown): boolean {
  if (header === null) return metaVersion !== MCP_PROTOCOL_VERSION;
  return HANDSHAKE_VERSIONS.some((version) => version === header);
}

async function inputSchemaOf(handler: WebHandler, request: Request, name: unknown): Promise<unknown> {
  const response = await handler(asCurrentRevisionRequest(request, "tools/list", {}));
  const result = response.ok ? parseObject(await response.text())?.["result"] : undefined;
  const tools = isJsonObject(result) && Array.isArray(result["tools"]) ? result["tools"] : [];
  const tool: unknown = tools.find((each: unknown) => isJsonObject(each) && each["name"] === name);
  return isJsonObject(tool) ? tool["inputSchema"] : undefined;
}

function asCurrentRevisionRequest(request: Request, method: string, params: JsonObject, paramHeaders: Record<string, string> = {}): Request {
  const headers = new Headers([...request.headers].filter(([name]) => !name.startsWith("mcp-param-")));
  headers.set("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
  headers.set("Mcp-Method", method);
  headers.set("Accept", "application/json, text/event-stream");
  if (method === "tools/call" && typeof params["name"] === "string") headers.set("Mcp-Name", encodeMcpHeaderValue(params["name"]));
  for (const [name, value] of Object.entries(paramHeaders)) headers.set(name, value);
  const meta = { ...metaOf({ params }), [PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_KEY]: {} };
  const body = JSON.stringify({ jsonrpc: "2.0", id: 0, method, params: { ...params, _meta: meta } });
  return new Request(request.url, { method: "POST", headers, body, signal: request.signal });
}

/**
 * The result of `initialize`, from the result of `server/discover`. The wrapper keeps no session, so it cannot send
 * `notifications/tools/list_changed`. The events extension is only for revision 2026-07-28, so the capabilities do not
 * have it (spec/bindings/mcp.md#events).
 */
function initializeResult(offered: unknown, discovered: JsonObject): JsonObject {
  const info = metaOf({ params: discovered })[SERVER_INFO_KEY];
  const name = isJsonObject(info) && typeof info["name"] === "string" ? info["name"] : "";
  const version = isJsonObject(info) && typeof info["version"] === "string" ? info["version"] : "";
  const instructions = typeof discovered["instructions"] === "string" ? discovered["instructions"] : undefined;
  const capabilities = isJsonObject(discovered["capabilities"]) ? discovered["capabilities"] : {};
  return {
    protocolVersion: HANDSHAKE_VERSIONS.find((each) => each === offered) ?? LATEST_HANDSHAKE_VERSION,
    capabilities: { ...withoutEvents(capabilities), tools: { listChanged: false } },
    serverInfo: { name, version },
    ...(instructions === undefined ? {} : { instructions }),
  };
}

function withoutEvents(capabilities: JsonObject): JsonObject {
  const { extensions, ...rest } = capabilities;
  if (!isJsonObject(extensions)) return capabilities;
  const { [MCP_EVENTS_EXTENSION]: _, ...others } = extensions;
  return Object.keys(others).length === 0 ? rest : { ...rest, extensions: others };
}

function metaOf(message: JsonObject): JsonObject {
  const params = message["params"];
  const meta = isJsonObject(params) ? params["_meta"] : undefined;
  return isJsonObject(meta) ? meta : {};
}

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
