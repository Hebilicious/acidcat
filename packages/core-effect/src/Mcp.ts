/**
 * The MCP binding (spec/bindings/mcp.md): an MCP server through HTTP, built on `effect/ai/McpServer`.
 */
import { MCP_REJECTIONS, mcpToolResult, readBounded, screenRequest } from "@acid-cat/spec-ts";
import type { JsonObject, Rejection } from "@acid-cat/spec-ts";
import { Cause, Context, Effect, Exit, Layer, ManagedRuntime } from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as App from "./App.ts";
import * as Capability from "./Capability.ts";
import { answer } from "./internal/answer.ts";
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
   * When `toWebHandler` builds the services from `layer`. With `"shared"`, the default, it builds them once, and all
   * requests use them. With `"per-request"`, it builds them for each request that passes the screening, and releases
   * them when the response is complete. Use `"per-request"` when a request must not use objects that an earlier request
   * made, for example on Cloudflare Workers, or when a stateful service must not be shared between callers.
   */
  readonly services?: "shared" | "per-request" | undefined;
}

/**
 * A web request handler for the MCP server: `(request) => Promise<Response>`. Each request has its own session.
 * `layer` gives the services that the capabilities need. `options.services` tells when the handler builds them. The
 * signal of the request cancels its call. A request that is aborted before its response rejects with the reason of
 * its signal, as an aborted `fetch` does.
 */
export function toWebHandler<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: Options) {
  if (options.services === "per-request") {
    return (request: Request): Promise<Response> =>
      answer(request, Effect.runPromiseExit(handle(app, request, options, layer), { signal: request.signal }));
  }
  // The runtime builds the services the first time that it runs, so the request is screened before it.
  const runtime = ManagedRuntime.make(layer);
  return async (request: Request): Promise<Response> => {
    const admitted = await admit(request, options);
    if (admitted instanceof Response) return admitted;
    return answer(request, runtime.runPromiseExit(respond(app, admitted, options), { signal: request.signal }));
  };
}

/**
 * Answer one MCP request with a new session. The request is screened and its body is bounded, as in `toWebHandler`.
 *
 * With `services`, the services are built for this request only after it passes the screening, and released when the
 * response is complete, so a request that is rejected builds nothing. With no `services`, a host that builds the
 * services itself provides them to this Effect.
 */
export function handle<R>(app: App.App<R>, request: Request, options: Options): Effect.Effect<Response, ServerError, R>;
export function handle<R, E, RIn>(
  app: App.App<R>,
  request: Request,
  options: Options,
  services: Layer.Layer<R, E, RIn>,
): Effect.Effect<Response, ServerError | E, RIn>;
export function handle<R, E, RIn>(
  app: App.App<R>,
  request: Request,
  options: Options,
  services?: Layer.Layer<R, E, RIn>,
): Effect.Effect<Response, ServerError | E, R | RIn> {
  return Effect.flatMap(
    Effect.promise(() => admit(request, options)),
    (admitted): Effect.Effect<Response, ServerError | E, R | RIn> => {
      if (admitted instanceof Response) return Effect.succeed(admitted);
      const answered = respond(app, admitted, options);
      return services === undefined ? answered : Effect.provide(answered, services);
    },
  );
}

/**
 * Screen a request and read its body (spec/bindings/mcp.md). The result is the rejection, or the request with the body
 * that was read.
 */
async function admit(request: Request, options: Options): Promise<Request | Response> {
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
  try {
    JSON.parse(body.text);
  } catch {
    return rejection("not-utf8");
  }
  return new Request(request.url, { body: body.text, headers: request.headers, method: "POST" });
}

/** An error of the MCP server of `effect/ai` while it answers a request. */
export type ServerError = Effect.Error<ReturnType<typeof respond<unknown>>>;

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
      const routes = Layer.effectDiscard(registerTools(session)).pipe(Layer.provideMerge(server));
      const respond = yield* HttpRouter.toHttpEffect(routes);
      const response = yield* respond.pipe(
        Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
      );
      return HttpServerResponse.toWeb(response);
    }),
  );

/**
 * Register one tool for each available capability in the view of the session. Each tool's schemas are written the first
 * time that a server registers it, then kept.
 */
export const registerTools = (session: Session.Session) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    for (const [id, capability] of session.capabilities) {
      if (!(yield* session.availability(id)).available) continue;
      // A lazy capability loads its schemas here. One that does not load is not listed, and its error is logged.
      const loaded = yield* Effect.exit(Capability.load(capability));
      if (Exit.isFailure(loaded)) {
        yield* Effect.logError("A capability did not load", Cause.pretty(loaded.cause));
        continue;
      }
      const output = App.outputJsonSchema(capability);
      const hasOutputSchema = output?.type === "object";
      yield* server.addTool({
        tool: new McpSchema.Tool({
          name: id,
          description: capability.description,
          inputSchema: App.inputJsonSchema(capability) as never,
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
