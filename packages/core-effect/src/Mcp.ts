/**
 * The MCP binding (spec/bindings/mcp.md): an MCP server through HTTP or through stdio, built on `effect/ai/McpServer`.
 */
import {
  bundle,
  isJsonObject,
  MCP_PROTOCOL_VERSION,
  MCP_REJECTIONS,
  mcpHandshakeResult,
  mcpHttpRevision,
  mcpInitializeResult,
  mcpToolResult,
  readBounded,
  screenRequest,
} from "@acid-cat/spec-ts";
import type { JsonObject, Outcome, Rejection } from "@acid-cat/spec-ts";
import { Cause, Context, Deferred, Effect, Exit, Fiber, Layer, Logger, ManagedRuntime, Schema, Stdio, Stream, SubscriptionRef } from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import type * as App from "./App.ts";
import { cancelOnAbort } from "./internal/cancel.ts";
import { refsOf } from "./internal/served.ts";
import * as Session from "./Session.ts";

export interface Options {
  /** The name and version that the server tells to clients. */
  readonly name: string;
  readonly version: string;
  /**
   * Guidance for a model about the whole server, which `server/discover` gives as `instructions`. The default is the
   * description of the application.
   */
  readonly instructions?: string | undefined;
  /** The origins that can call the server. A request with no `Origin` header is accepted. */
  readonly allowedOrigins: readonly string[];
  /** The target that the server serves. The default is `"mcp"`. */
  readonly target?: string | undefined;
  /** The URL path. The default is `"/mcp"`. */
  readonly path?: `/${string}` | undefined;
  /** The maximum size of a request body, in bytes. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
  /**
   * When `toWebHandler` builds the services from `layer`. With `"shared"`, the default, it builds them once, for the
   * first request that passes the screening, and all requests use them. With `"per-request"`, it builds them for each
   * request that passes the screening, and releases them when the response is complete. Use `"per-request"` when a
   * request must not use objects that an earlier request made, for example on Cloudflare Workers, or when a stateful
   * service must not be shared between callers.
   */
  readonly services?: "shared" | "per-request" | undefined;
}

/**
 * A web request handler for the MCP server: `(request) => Promise<Response>`. Each request has its own session.
 * `layer` gives the services that the capabilities need. `options.services` tells when the handler builds them.
 */
export function toWebHandler<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: Options) {
  const runtime = options.services === "per-request" ? undefined : ManagedRuntime.make(layer);
  return async (request: Request): Promise<Response> => {
    const admitted = await admit(request, options);
    if (admitted instanceof Response) return admitted;
    const early = answerWithoutSession(app, admitted, options);
    if (early !== undefined) return early;
    const answer = respondTo(app, admitted, options);
    return runtime === undefined ? Effect.runPromise(Effect.provide(answer, layer)) : runtime.runPromise(answer);
  };
}

/**
 * Answer one MCP request with a new session. The request is screened and its body is bounded, as in `toWebHandler`.
 * A host that builds the services itself provides them to this Effect.
 */
export const handle = <R>(app: App.App<R>, request: Request, options: Options) =>
  Effect.flatMap(
    Effect.promise(() => admit(request, options)),
    (admitted) => {
      if (admitted instanceof Response) return Effect.succeed(admitted);
      const early = answerWithoutSession(app, admitted, options);
      return early === undefined ? respondTo(app, admitted, options) : Effect.succeed(early);
    },
  );

/** A request that passed the screening: the request with the body that was read, and the parsed body. */
interface Admitted {
  readonly request: Request;
  readonly message: JsonObject;
  readonly current: boolean;
}

/**
 * Screen a request, read its body and find its revision (spec/bindings/mcp.md). The result is the rejection, or the
 * request with the body that was read and the signal of the request.
 */
async function admit(request: Request, options: Options): Promise<Admitted | Response> {
  const maximumBytes = options.maximumBytes ?? 1_048_576;
  const screened = screenRequest(request, {
    methods: ["POST"],
    allowedOrigins: options.allowedOrigins,
    mediaType: "application/json",
    maximumBytes,
  });
  if (screened !== undefined) return rejection(screened);
  const body = await readBounded(request, maximumBytes);
  if ("rejection" in body) return rejection(body.rejection);
  let parsed: unknown;
  try {
    parsed = JSON.parse(body.text);
  } catch {
    return rejection("not-utf8");
  }
  const message = isJsonObject(parsed) ? parsed : {};
  const params = isJsonObject(message["params"]) ? message["params"] : {};
  const meta = isJsonObject(params["_meta"]) ? params["_meta"] : {};
  const revision = mcpHttpRevision(request.headers.get("MCP-Protocol-Version"), meta[PROTOCOL_VERSION_KEY]);
  if (revision.revision === "rejected") {
    const { code, message: text, data } = revision;
    return json({ jsonrpc: "2.0", id: idOf(message), error: { code, message: text, ...(data === undefined ? {} : { data }) } }, 400);
  }
  const admitted = new Request(request.url, { body: body.text, headers: request.headers, method: "POST", signal: request.signal });
  return { request: admitted, message, current: revision.revision === "current" };
}

const PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion";
const CLIENT_CAPABILITIES_KEY = "io.modelcontextprotocol/clientCapabilities";

/** The id of a JSON-RPC message, or `null` when it has none or when it is not a string or a number. */
const idOf = (message: JsonObject) => {
  const id = message["id"];
  return typeof id === "string" || typeof id === "number" ? id : null;
};

/**
 * The answer to a request of a revision with a handshake that needs no session: a notification, `initialize` and
 * `ping`. The server keeps no state for the handshake. Other requests give `undefined`.
 */
function answerWithoutSession<R>(app: App.App<R>, admitted: Admitted, options: Options): Response | undefined {
  if (admitted.current) return undefined;
  const { message } = admitted;
  if (!("id" in message)) return new Response(null, { status: 202 });
  const id = idOf(message);
  const params = isJsonObject(message["params"]) ? message["params"] : {};
  switch (message["method"]) {
    case "initialize": {
      const server = { name: options.name, version: options.version, instructions: options.instructions ?? app.description };
      return json({ jsonrpc: "2.0", id, result: mcpInitializeResult(params["protocolVersion"], server, { tools: { listChanged: false } }) });
    }
    case "ping":
      return json({ jsonrpc: "2.0", id, result: {} });
    case "tools/list":
    case "tools/call":
      return undefined;
    default:
      return json({ jsonrpc: "2.0", id, error: { code: -32601, message: `Method not found: ${String(message["method"])}` } });
  }
}

/**
 * Answer a request that needs a session. A request of a revision with a handshake goes to the server as a request of
 * revision 2026-07-28, and its result loses the members that only revision 2026-07-28 has.
 */
const respondTo = <R>(app: App.App<R>, admitted: Admitted, options: Options) => {
  if (admitted.current) return respond(app, admitted.request, options);
  const { message } = admitted;
  const id = idOf(message);
  const method = typeof message["method"] === "string" ? message["method"] : "";
  const params = isJsonObject(message["params"]) ? message["params"] : {};
  const meta = isJsonObject(params["_meta"]) ? params["_meta"] : {};
  const headers = new Headers(admitted.request.headers);
  headers.set("MCP-Protocol-Version", MCP_PROTOCOL_VERSION);
  headers.set("Mcp-Method", method);
  headers.set("Accept", "application/json, text/event-stream");
  if (method === "tools/call" && typeof params["name"] === "string") headers.set("Mcp-Name", params["name"]);
  const body = { ...message, params: { ...params, _meta: { ...meta, [PROTOCOL_VERSION_KEY]: MCP_PROTOCOL_VERSION, [CLIENT_CAPABILITIES_KEY]: {} } } };
  const request = new Request(admitted.request.url, { method: "POST", headers, body: JSON.stringify(body), signal: admitted.request.signal });
  return Effect.flatMap(respond(app, request, options), (response) =>
    Effect.promise(async () => {
      const answer = await messageOf(response);
      const result = memberOf(answer, "result");
      if (isJsonObject(result)) return json({ jsonrpc: "2.0", id, result: mcpHandshakeResult(result) });
      const error = memberOf(answer, "error");
      return json({ jsonrpc: "2.0", id, error: isJsonObject(error) ? error : { code: -32603, message: "The server gave no answer." } });
    }),
  );
};

const memberOf = (value: unknown, member: string) => (isJsonObject(value) ? value[member] : undefined);

/** The JSON-RPC answer in a response: the body, or the last message of a stream of server-sent events. */
async function messageOf(response: Response): Promise<unknown> {
  const text = await response.text();
  if (!(response.headers.get("Content-Type") ?? "").includes("text/event-stream")) return parseOrNull(text);
  const messages = text
    .split("\n")
    .filter((line) => line.startsWith("data:"))
    .map((line) => parseOrNull(line.slice("data:".length)))
    .filter((each) => isJsonObject(each) && "id" in each);
  return messages.at(-1) ?? null;
}

function parseOrNull(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
}

const json = (body: JsonObject, status = 200) => new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

/** Answer one MCP request that passed the screening, with a new session. */
const respond = <R>(app: App.App<R>, request: Request, options: Options) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* Session.make(app, { target: options.target ?? "mcp" });
      const server = McpServer.layerHttp({
        name: options.name,
        version: options.version,
        instructions: options.instructions ?? app.description,
        path: options.path ?? "/mcp",
        protocols: [McpProtocol.v2026_07_28],
        allowedOrigins: [...options.allowedOrigins],
      });
      const routes = Layer.effectDiscard(registerTools(session, request.signal)).pipe(Layer.provideMerge(server));
      const respond = yield* HttpRouter.toHttpEffect(routes);
      const response = yield* respond.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
      );
      return HttpServerResponse.toWeb(response);
    }),
  );

/**
 * Register one tool for each available capability in the view of the session. The abort of `signal` cancels the calls
 * of the tools.
 */
export const registerTools = (session: Session.Session, signal: AbortSignal = new AbortController().signal) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const id of Object.keys(session.view.capabilities)) {
      if (!(yield* session.availability(id)).available) continue;
      yield* server.addTool(yield* toolFor(session, id, Context.empty(), cancelOnAbort(signal)));
    }
  });

/**
 * The tool of a capability in the view of a session: its name, description, schemas and hints, and its call.
 * `annotations` go to `effect/ai`. `around` wraps each call, for example to cancel it.
 */
const toolFor = (
  session: Session.Session,
  id: string,
  annotations: Context.Context<never>,
  around: (call: Effect.Effect<Outcome<unknown, unknown>>) => Effect.Effect<Outcome<unknown, unknown>> = (call) => call,
) =>
  Effect.gen(function* () {
    const capability = session.view.capabilities[id];
    if (capability === undefined) return yield* Effect.die(new Error(`The view of the session has no capability ${id}.`));
    const types = session.view.$defs ?? {};
    const output = capability.output === undefined ? undefined : bundle(capability.output, types);
    const hasOutputSchema = output?.type === "object";
    const inputSchema = yield* decodeToolInput(bundle(capability.input ?? { type: "object" }, types));
    const outputSchema = hasOutputSchema ? yield* decodeToolOutput(output) : undefined;
    return {
      tool: new McpSchema.Tool({
        name: id,
        description: capability.description,
        inputSchema,
        ...(outputSchema === undefined ? {} : { outputSchema }),
        annotations: { readOnlyHint: capability.readOnly === true },
      }),
      annotations,
      handle: (payload: unknown) =>
        around(session.invoke(id, payload ?? {})).pipe(Effect.flatMap((outcome) => decodeToolResult(mcpToolResult(outcome, hasOutputSchema)))),
    };
  });

export interface StdioOptions {
  /** The name and version that the server tells to clients. */
  readonly name: string;
  readonly version: string;
  /** Guidance for a model about the whole server. The default is the description of the application. */
  readonly instructions?: string | undefined;
  /** The target that the server serves. The default is `"mcp"`. */
  readonly target?: string | undefined;
}

/**
 * The MCP server through the standard input and output of `Stdio` (spec/bindings/mcp.md#stdio), while the scope of the
 * layer is open. The server is one session. It serves revision 2026-07-28, and the `initialize` handshake of revisions
 * 2025-11-25 and 2025-06-18. The logs of the effects in the layer go to standard error.
 */
export const layerStdio = <R>(app: App.App<R>, options: StdioOptions) =>
  Layer.effectDiscard(
    Effect.gen(function* () {
      const session = yield* Session.make(app, { target: options.target ?? "mcp" });
      yield* serveTools(session);
    }),
  ).pipe(
    Layer.provideMerge(
      McpServer.layerStdio({
        name: options.name,
        version: options.version,
        instructions: options.instructions ?? app.description,
        protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25, McpProtocol.v2025_06_18],
      }),
    ),
    Layer.provide(Layer.effect(Stdio.Stdio, Effect.map(Effect.service(Stdio.Stdio), framed))),
    // Standard output carries only MCP messages, so the logs go to standard error.
    Layer.provide(Layer.succeed(Logger.LogToStderr, true)),
  );

/**
 * Standard input, one JSON message on each line. The server answers a line that is not JSON with the JSON-RPC error
 * -32700, and keeps the session. An empty line is ignored.
 */
const framed = (stdio: Stdio.Stdio): Stdio.Stdio => {
  const parseError = `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "The line is not JSON." } })}\n`;
  const isJson = (line: string) => {
    try {
      JSON.parse(line);
      return true;
    } catch {
      return false;
    }
  };
  const stdin = stdio.stdin.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.trim() !== ""),
    Stream.filterEffect((line) =>
      isJson(line) ? Effect.succeed(true) : Effect.as(Effect.ignore(Stream.run(Stream.make(parseError), stdio.stdout())), false),
    ),
    Stream.map((line) => `${line}\n`),
    Stream.encodeText,
  );
  return Stdio.make({ ...stdio, stdin });
};

/**
 * Serve the MCP server through the standard input and output of `Stdio` until standard input ends. Then the session
 * closes: the calls in progress are cancelled, and the effect completes. The process is one session.
 */
export const serveStdio = <R>(app: App.App<R>, options: StdioOptions) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const ended = yield* Deferred.make<void>();
    const input = Stdio.make({ ...stdio, stdin: stdio.stdin.pipe(Stream.ensuring(Deferred.done(ended, Exit.void))) });
    const server = layerStdio(app, options).pipe(Layer.provide(Layer.succeed(Stdio.Stdio, input)));
    // When the server stops writing standard output, it interrupts its own fiber. That is a normal end too.
    const fiber = yield* Effect.forkChild(Layer.launch(server), { startImmediately: true });
    yield* Effect.raceFirst(Effect.asVoid(Fiber.await(fiber)), Deferred.await(ended));
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause);
  });

/**
 * Register one tool for each capability in the view of the session. A tool is listed and can be called only while its
 * capability is available. When the set of available capabilities changes, the server sends
 * `notifications/tools/list_changed`.
 */
const serveTools = (session: Session.Session) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const refs = refsOf(session);
    const ids = Object.keys(session.view.capabilities);
    const isAvailable = (id: string) => {
      const ref = refs.availability(id);
      return ref === undefined || SubscriptionRef.getUnsafe(ref).available;
    };
    // The availability of each capability, as the server last saw it in the stream of its changes. The server compares
    // the values of the stream, not the values at the moment that it reads them: when a capability becomes available and
    // then unavailable before the server reads the first change, the server still sees both changes, and tells both.
    const seen = new Map(ids.map((id) => [id, isAvailable(id)]));
    const seenIds = () => ids.filter((id) => seen.get(id) === true).join("\n");
    let listed = seenIds();
    // Each availability gives its current value when the stream subscribes to it, then each change.
    const followed = ids.flatMap((id) => {
      const ref = refs.availability(id);
      return ref === undefined ? [] : [SubscriptionRef.changes(ref).pipe(Stream.map((availability) => ({ id, available: availability.available })))];
    });
    yield* Stream.mergeAll(followed, { concurrency: "unbounded" }).pipe(
      Stream.runForEach(({ id, available }) =>
        Effect.suspend(() => {
          seen.set(id, available);
          const next = seenIds();
          if (next === listed) return Effect.void;
          listed = next;
          return server.notifications["notifications/tools/list_changed"]({});
        }),
      ),
      Effect.forkScoped({ startImmediately: true }),
    );
    for (const id of ids) yield* server.addTool(yield* toolFor(session, id, Context.make(McpSchema.EnabledWhen, () => isAvailable(id))));
  });

/**
 * The schemas of a tool, and its result, in the types of `effect/ai`. The catalog makes each of them, so a value that
 * does not decode is a defect.
 */
const decodeToolInput = (schema: JsonObject) => Effect.orDie(Schema.decodeUnknownEffect(McpSchema.ToolJson)(schema));
const decodeToolOutput = (schema: unknown) => Effect.orDie(Schema.decodeUnknownEffect(McpSchema.ToolOutputJson)(schema));
const decodeToolResult = (result: unknown) => Effect.orDie(Schema.decodeUnknownEffect(McpSchema.CallToolResult)(result));

function rejection(reason: Rejection): Response {
  const { status, code } = MCP_REJECTIONS[reason];
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (reason === "method") headers.set("Allow", "POST");
  if (code === undefined) return new Response(null, { status, headers });
  const body: JsonObject = { jsonrpc: "2.0", id: null, error: { code, message: messages[reason] } };
  headers.set("Content-Type", "application/json");
  return new Response(JSON.stringify(body), { status, headers });
}

const messages: { readonly [R in Rejection]: string } = {
  method: "Use POST.",
  origin: "This origin is not allowed.",
  "media-type": "Use application/json.",
  "too-large": "The request body is too large.",
  "not-utf8": "The request body is not UTF-8 JSON.",
};
