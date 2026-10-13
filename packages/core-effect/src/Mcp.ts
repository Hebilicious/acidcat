/**
 * The MCP binding (spec/bindings/mcp.md): an MCP server through HTTP, built on `effect/ai/McpServer`.
 */
import { bundle, MCP_REJECTIONS, mcpToolResult, readBounded, screenRequest } from "@acid-cat/spec";
import type { JsonObject, Rejection } from "@acid-cat/spec";
import { Context, Effect, Layer, ManagedRuntime } from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import type * as App from "./App.ts";
import * as Session from "./Session.ts";

export interface Options {
  /** The name and version that the server tells to clients. */
  readonly name: string;
  readonly version: string;
  /** The origins that can call the server. A request with no `Origin` header is accepted. */
  readonly allowedOrigins: readonly string[];
  /** The target that the server serves. The default is `"mcp"`. */
  readonly target?: string | undefined;
  /** The URL path. The default is `"/mcp"`. */
  readonly path?: `/${string}` | undefined;
  /** The maximum size of a request body, in bytes. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
}

/**
 * A web request handler for the MCP server: `(request) => Promise<Response>`. Each request has its own session.
 * `layer` gives the services that the capabilities need.
 */
export function toWebHandler<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: Options) {
  const runtime = ManagedRuntime.make(layer);
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
    try {
      JSON.parse(body.text);
    } catch {
      return rejection("not-utf8");
    }
    const message = new Request(request.url, { body: body.text, headers: request.headers, method: "POST" });
    return runtime.runPromise(handle(app, message, options));
  };
}

/** Answer one MCP request with a new session. */
export const handle = <R>(app: App.App<R>, request: Request, options: Options) =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* Session.make(app, { target: options.target ?? "mcp" });
      const server = McpServer.layerHttp({
        name: options.name,
        version: options.version,
        path: options.path ?? "/mcp",
        protocols: [McpProtocol.v2026_07_28],
        allowedOrigins: [...options.allowedOrigins],
      });
      const routes = Layer.effectDiscard(registerTools(session)).pipe(Layer.provideMerge(server));
      const respond = yield* HttpRouter.toHttpEffect(routes);
      const response = yield* respond.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
      );
      return HttpServerResponse.toWeb(response);
    }),
  );

/** Register one tool for each available capability in the view of the session. */
export const registerTools = (session: Session.Session) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const types = session.view.$defs ?? {};
    for (const [id, capability] of Object.entries(session.view.capabilities)) {
      if (!(yield* session.availability(id)).available) continue;
      const output = capability.output === undefined ? undefined : bundle(capability.output, types);
      const hasOutputSchema = output?.type === "object";
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: id,
          description: capability.description,
          inputSchema: bundle(capability.input ?? { type: "object" }, types) as never,
          ...(hasOutputSchema ? { outputSchema: output as never } : {}),
          annotations: { readOnlyHint: capability.readOnly === true },
        }),
        annotations: Context.empty(),
        handle: (payload: unknown) =>
          session
            .invoke(id, payload ?? {})
            .pipe(Effect.map((outcome) => new McpSchema.CallToolResult(mcpToolResult(outcome, hasOutputSchema) as never))),
      });
    }
  });

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
