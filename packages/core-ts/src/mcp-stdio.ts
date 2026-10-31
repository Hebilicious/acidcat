/**
 * The MCP binding through standard input and standard output (spec/bindings/mcp.md#stdio). The process is one session.
 * The server serves revision 2026-07-28, and the `initialize` handshake of revisions 2025-11-25 and 2025-06-18.
 */
import { isJsonObject, MCP_PROTOCOL_VERSION, MCP_UNKNOWN_TOOL, mcpToolResult } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import type { App, ToJsonSchema } from "./app.ts";
import { hasObjectOutput, listTools } from "./mcp.ts";
import { createSession } from "./session.ts";
import type { Session } from "./session.ts";

export interface McpStdioOptions<Context> {
  readonly name: string;
  readonly version: string;
  /** Guidance for a model about the whole server. The default is the description of the application. */
  readonly instructions?: string | undefined;
  /** The context of the session. */
  readonly context: Context;
  readonly toJsonSchema: ToJsonSchema;
  /** The target that the server serves. The default is `"mcp"`. */
  readonly target?: string | undefined;
}

export interface McpStdioIo {
  /** Standard input: bytes or text, one JSON-RPC message on each line. */
  readonly input: AsyncIterable<string | Uint8Array>;
  /** Write one line to standard output. The text ends with a newline. */
  readonly write: (text: string) => void;
}

/** The revisions with an `initialize` handshake that the server serves, the latest first. */
const HANDSHAKE_VERSIONS = ["2025-11-25", "2025-06-18"] as const;

const SUPPORTED_VERSIONS = [MCP_PROTOCOL_VERSION, ...HANDSHAKE_VERSIONS];

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId";

type Id = string | number;

/** The members of a JSON-RPC message that the server reads. */
interface Message {
  readonly id: Id | null | undefined;
  readonly method: string | undefined;
  readonly params: JsonObject;
  /** The revision in `params._meta`. Only requests of revision 2026-07-28 have it. */
  readonly protocolVersion: unknown;
}

function readMessage(body: JsonObject): Message {
  const { id, method, params } = body;
  const members = isJsonObject(params) ? params : {};
  const meta = members["_meta"];
  return {
    id: typeof id === "string" || typeof id === "number" ? id : "id" in body ? null : undefined,
    method: typeof method === "string" ? method : undefined,
    params: members,
    protocolVersion: isJsonObject(meta) ? meta[PROTOCOL_VERSION_KEY] : undefined,
  };
}

/**
 * Serve the MCP server on the lines of `io.input` until the input ends. Then the session closes: the calls in progress
 * are cancelled, and the promise resolves. This function works in all runtimes.
 */
export async function runMcpStdio<Context>(app: App<Context>, options: McpStdioOptions<Context>, io: McpStdioIo): Promise<void> {
  const session = createSession(app, { target: options.target ?? "mcp", context: options.context, toJsonSchema: options.toJsonSchema });
  const instructions = options.instructions ?? app.description;
  const server = new StdioServer(session, { ...options, instructions }, io.write);
  try {
    for await (const line of lines(io.input)) server.receive(line);
  } finally {
    await server.close();
  }
}

/**
 * Run the MCP server on the standard input and output of the process, until standard input ends. The logs of the
 * session go to standard error.
 */
export function main<Context>(app: App<Context>, options: McpStdioOptions<Context>): void {
  void runMcpStdio(app, options, { input: process.stdin, write: (text) => process.stdout.write(text) });
}

/** The lines of a stream of bytes or text, without their line ends. */
async function* lines(input: AsyncIterable<string | Uint8Array>): AsyncGenerator<string> {
  const decoder = new TextDecoder();
  let rest = "";
  for await (const chunk of input) {
    rest += typeof chunk === "string" ? chunk : decoder.decode(chunk, { stream: true });
    const parts = rest.split("\n");
    rest = parts.pop() ?? "";
    yield* parts;
  }
  rest += decoder.decode();
  if (rest !== "") yield rest;
}

/** The information that the server gives about itself. */
interface ServerInfo {
  readonly name: string;
  readonly version: string;
  readonly instructions: string | undefined;
}

/** The state of the one session of the process: the requests in progress, the subscriptions, and the handshake. */
class StdioServer {
  readonly #session: Session;
  readonly #options: ServerInfo;
  readonly #write: (text: string) => void;
  /** The calls in progress, by request id. `notifications/cancelled` aborts them. */
  readonly #calls = new Map<Id, AbortController>();
  /** The open `subscriptions/listen` requests of revision 2026-07-28 that asked for tool list changes. */
  readonly #subscriptions = new Set<Id>();
  /** True after the `initialize` handshake: the client then gets `notifications/tools/list_changed` with no subscription. */
  #initialized = false;
  #listed: string;
  readonly #changes: { unsubscribe(): void };

  constructor(session: Session, options: ServerInfo, write: (text: string) => void) {
    this.#session = session;
    this.#options = options;
    this.#write = write;
    this.#listed = this.#availableIds();
    this.#changes = session.onChange(() => this.#announce());
  }

  /** Read one line of standard input. An empty line is ignored. */
  receive(line: string): void {
    if (line.trim() === "") return;
    let body: unknown;
    try {
      body = JSON.parse(line);
    } catch {
      return this.#error(null, -32700, "The line is not JSON.");
    }
    if (Array.isArray(body)) return this.#error(null, -32600, "JSON-RPC batches are not supported.");
    if (!isJsonObject(body)) return this.#error(null, -32600, "A message must be a JSON object.");
    const message = readMessage(body);
    if (message.method === undefined) {
      // A response of the client. The server sends no requests, so it reads none.
      if (message.id !== undefined) return;
      return this.#error(null, -32600, "A message must have a method.");
    }
    if (message.id === undefined) return this.#notification(message);
    void this.#request({ ...message, id: message.id ?? null });
  }

  /** Close the session: stop the subscriptions, and cancel the calls in progress. */
  async close(): Promise<void> {
    this.#changes.unsubscribe();
    this.#subscriptions.clear();
    for (const controller of this.#calls.values()) controller.abort();
    await this.#session.dispose();
  }

  #notification(message: Message): void {
    if (message.method !== "notifications/cancelled") return;
    const requestId = message.params["requestId"];
    if (typeof requestId !== "string" && typeof requestId !== "number") return;
    this.#calls.get(requestId)?.abort();
    this.#subscriptions.delete(requestId);
  }

  async #request(message: Message & { readonly id: Id | null }): Promise<void> {
    const { id, method, protocolVersion } = message;
    if (method === "initialize") return this.#initialize(id, message.params["protocolVersion"]);
    if (method === "ping") return this.#result(id, {});
    const modern = protocolVersion !== undefined;
    if (modern && protocolVersion !== MCP_PROTOCOL_VERSION) {
      return this.#error(id, -32022, `Unsupported protocol version ${JSON.stringify(protocolVersion)}`, { supported: SUPPORTED_VERSIONS });
    }
    /** The result of a request: in revision 2026-07-28 it has the server information and a result type. */
    const complete = (result: JsonObject, list = false) =>
      this.#result(
        id,
        modern
          ? {
              _meta: { "io.modelcontextprotocol/serverInfo": { name: this.#options.name, version: this.#options.version } },
              resultType: "complete",
              ...(list ? { ttlMs: 0, cacheScope: "private" } : {}),
              ...result,
            }
          : result,
      );
    switch (method) {
      case "server/discover":
        return complete(
          {
            supportedVersions: SUPPORTED_VERSIONS,
            capabilities: { tools: { listChanged: true } },
            ...(this.#options.instructions === undefined ? {} : { instructions: this.#options.instructions }),
          },
          true,
        );
      case "subscriptions/listen":
        return this.#listen(id, message.params);
      case "tools/list":
        return complete({ tools: listTools(this.#session) }, true);
      case "tools/call":
        return this.#call(id, message.params, complete);
      default:
        return this.#error(id, -32601, `Method not found: ${method}`);
    }
  }

  /** The `initialize` handshake. The server selects the revision of the client if it serves it, or else its latest. */
  #initialize(id: Id | null, offered: unknown): void {
    const version = HANDSHAKE_VERSIONS.find((each) => each === offered) ?? HANDSHAKE_VERSIONS[0];
    this.#result(id, {
      protocolVersion: version,
      capabilities: { tools: { listChanged: true } },
      serverInfo: { name: this.#options.name, version: this.#options.version },
      ...(this.#options.instructions === undefined ? {} : { instructions: this.#options.instructions }),
    });
    this.#initialized = true;
  }

  /**
   * A `subscriptions/listen` request of revision 2026-07-28. The server honors only tool list changes. The request
   * stays open until the client cancels it or standard input ends, so the server never answers it.
   */
  #listen(id: Id | null, params: JsonObject): void {
    const wanted = params["notifications"];
    const tools = isJsonObject(wanted) && wanted["toolsListChanged"] === true && id !== null;
    this.#send({
      jsonrpc: "2.0",
      method: "notifications/subscriptions/acknowledged",
      params: { _meta: { [SUBSCRIPTION_ID_KEY]: id }, notifications: tools ? { toolsListChanged: true } : {} },
    });
    if (tools) this.#subscriptions.add(id);
  }

  async #call(id: Id | null, params: JsonObject, complete: (result: JsonObject) => void): Promise<void> {
    const name = typeof params["name"] === "string" ? params["name"] : "";
    const handle = this.#session.handles.get(name);
    if (handle === undefined || !handle.availability.getSnapshot().available) {
      return this.#error(id, MCP_UNKNOWN_TOOL, `Tool '${name}' not found`);
    }
    const controller = new AbortController();
    if (id !== null) this.#calls.set(id, controller);
    try {
      const outcome = await this.#session.invoke(name, params["arguments"] ?? {}, { signal: controller.signal });
      // The server does not answer a cancelled request.
      if (controller.signal.aborted) return;
      complete({ ...mcpToolResult(outcome, hasObjectOutput(this.#session, name)) });
    } finally {
      if (id !== null && this.#calls.get(id) === controller) this.#calls.delete(id);
    }
  }

  /** The ids of the available tools, as one string, to compare two sets. */
  #availableIds(): string {
    return [...this.#session.handles.values()]
      .filter((handle) => handle.availability.getSnapshot().available)
      .map((handle) => handle.id)
      .join("\n");
  }

  /** Tell the client when the set of available tools changes. */
  #announce(): void {
    const next = this.#availableIds();
    if (next === this.#listed) return;
    this.#listed = next;
    if (this.#initialized) this.#send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: {} });
    for (const id of this.#subscriptions) {
      this.#send({ jsonrpc: "2.0", method: "notifications/tools/list_changed", params: { _meta: { [SUBSCRIPTION_ID_KEY]: id } } });
    }
  }

  #result(id: Id | null, result: JsonObject): void {
    this.#send({ jsonrpc: "2.0", id, result });
  }

  #error(id: Id | null, code: number, message: string, data?: JsonObject): void {
    this.#send({ jsonrpc: "2.0", id, error: { code, message, ...(data === undefined ? {} : { data }) } });
  }

  #send(message: JsonObject): void {
    this.#write(`${JSON.stringify(message)}\n`);
  }
}
