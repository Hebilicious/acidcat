import {
  bundle,
  isJsonObject,
  KEEPALIVE_MS,
  MCP_EVENTS_EXTENSION,
  MCP_HEADER_MISMATCH,
  MCP_PROTOCOL_VERSION,
  MCP_REJECTIONS,
  mcpHeaderMismatch,
  mcpServerCard,
  mcpServerCardIdentity,
  mcpServerCardResponse,
  mcpServerUrlOfCardRequest,
  mcpToolAnnotations,
  mcpToolResult,
  publishesOnServerCard,
  readBounded,
  screenRequest,
  SSE_MEDIA_TYPE,
  sseMessage,
  viewOf,
} from "@acid-cat/spec-ts";
import type { JsonObject, McpServerCardIdentity, McpServerCardSettings, Outcome, Rejection } from "@acid-cat/spec-ts";
import { Cause, Context, Deferred, Effect, Exit, Fiber, FiberMap, Layer, Logger, Option, Queue, Schema, Scope, Semaphore, Sink, Stdio, Stream, SubscriptionRef } from "effect";
import { McpProtocol, McpSchema, McpServer } from "effect/ai";
import { HttpEffect, HttpRouter, HttpServerRequest, HttpServerResponse } from "effect/http";

import * as App from "./App.ts";
import { cancelOnAbort } from "./internal/cancel.ts";
import * as McpEvents from "./internal/mcpEvents.ts";
import { makePolls } from "./internal/poll.ts";
import type { Opener, Polls, PollOptions } from "./internal/poll.ts";
import { refsOf } from "./internal/served.ts";
import { makeWebhooks } from "./internal/webhooks.ts";
import type { WebhookOptions, Webhooks } from "./internal/webhooks.ts";
import { answerWith, closeUnlessStreaming, eventStream, keepNothing } from "./internal/web.ts";
import type { Keep, Streaming } from "./internal/web.ts";
import type { IncomingRequest } from "./Remote.ts";
import * as Session from "./Session.ts";

export type { PollOptions } from "./internal/poll.ts";
export type { McpServerCardSettings as ServerCardSettings, WebhookSigningJwk } from "@acid-cat/spec-ts";
export { WebhookSendError } from "./internal/webhooks.ts";
export type { WebhookOptions, WebhookRequest, WebhookResponse, WebhookSender } from "./internal/webhooks.ts";

/**
 * Wrap the web handler of `toWebHandler` so that it also serves MCP clients of revisions 2025-11-25 and 2025-06-18,
 * which open the session with `initialize` (spec/bindings/mcp.md#earlier-revisions-through-http). It keeps no state.
 */
export { mcpHandshake as withHandshake } from "@acid-cat/mcp-handshake";
export type { McpHandshakeOptions as HandshakeOptions } from "@acid-cat/mcp-handshake";

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
   * service must not be shared between callers. With `"per-request"`, the layer can read the head of the request from
   * `Remote.IncomingRequest`, and refuse the request with a `Remote.Refusal`.
   */
  readonly services?: "shared" | "per-request" | undefined;
  /**
   * The time in milliseconds with no message on the stream of `events/stream` after which the server sends
   * `notifications/events/heartbeat`. The default is 15 000.
   */
  readonly heartbeatMs?: number | undefined;
  /** The number of occurrences of one subscription that the session keeps for a slow client. See `Session.Options`. */
  readonly eventBuffer?: number | undefined;
  /**
   * The identity of the client of a request: the principal. A poll lease belongs to the principal of the request that
   * started it. Webhook delivery needs a principal. With no function, or with `Option.none()`, the request has no
   * principal. Check the credentials of the request here, for example a bearer token.
   */
  readonly principal?: ((request: Request) => Effect.Effect<Option.Option<string>>) | undefined;
  readonly poll?: PollOptions | undefined;
  /**
   * The settings of webhook delivery (spec/bindings/mcp.md#webhook). Webhook delivery is off when this member is
   * absent. `NodeWebhook.sender` from `@acid-cat/core-effect/node` gives a sender for Node.js.
   */
  readonly webhooks?: WebhookOptions | undefined;
  /**
   * Serve a Server Card at the URL of the server and `/server-card` (spec/bindings/mcp.md#server-card). With no card,
   * a `GET` request to that URL gets 404. A card whose name, description or version breaks the rules makes the server
   * fail when it starts. So do webhook signing keys or egress ranges with no card.
   */
  readonly serverCard?: McpServerCardSettings | undefined;
}

export interface WebHandler {
  (request: Request): Promise<Response>;
  /** End the poll leases and the webhook subscriptions, and release the shared services. */
  readonly dispose: () => Promise<void>;
}

interface Deliveries {
  readonly polls: Polls | undefined;
  readonly webhooks: Webhooks | undefined;
}

const makeDeliveries = (options: Pick<Options, "poll" | "webhooks">): Effect.Effect<Deliveries, never, Scope.Scope> =>
  Effect.gen(function* () {
    const polls = yield* makePolls(options.poll);
    const webhooks = options.webhooks === undefined ? undefined : yield* makeWebhooks(options.webhooks);
    return { polls, webhooks };
  });

/**
 * A web request handler for the MCP server: `(request) => Promise<Response>`. Each request has its own session.
 * `layer` gives the services that the capabilities need. `options.services` tells when the handler builds them.
 *
 * The handler keeps the poll leases and the webhook subscriptions between requests, in the memory of the process.
 * Each one holds a subscription in a session of its own, with the services of the request that started it. With
 * `"per-request"`, these services stay open until the lease or the subscription ends. `dispose` ends them all.
 *
 * With `"per-request"`, the layer can read the head of the request from `Remote.IncomingRequest`, for example to
 * find the caller. When the layer fails with a `Remote.Refusal`, the handler answers with the refusal before it opens
 * a session.
 */
export function toWebHandler<R, E>(app: App.App<R>, layer: Layer.Layer<R, E, IncomingRequest>, options: Options & { readonly services: "per-request" }): WebHandler;
export function toWebHandler<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: Options): WebHandler;
export function toWebHandler<R, E>(app: App.App<R>, layer: Layer.Layer<R, E, IncomingRequest>, options: Options): WebHandler {
  const identity = cardIdentity(app, options);
  const { answer, dispose: release } = answerWith(layer, options.services);
  const scope = Effect.runSync(Scope.make());
  const deliveries = Effect.runSync(makeDeliveries(options).pipe(Scope.provide(scope)));
  const handler = async (request: Request): Promise<Response> => {
    const card = await Effect.runPromise(answerCard(request, identity, deliveries.webhooks));
    if (card !== undefined) return card;
    const admitted = await admit(request, options);
    if (admitted instanceof Response) return admitted;
    return answer(admitted.request, (requestScope, keep) => respond(app, admitted, options, requestScope, { ...deliveries, keep }));
  };
  const dispose = async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await release();
  };
  return Object.assign(handler, { dispose });
}

/**
 * Answer one MCP request with a new session. The request is screened and its body is bounded, as in `toWebHandler`.
 * A host that builds the services itself provides them to this Effect. The services must stay open until the stream
 * of `events/stream` ends.
 *
 * This function keeps no state between requests. So it delivers events only with push: `events/poll` and the
 * webhook methods answer `Unsupported`. Use `makeHandle` for a server that also delivers with poll and webhooks.
 */
export const handle = <R>(app: App.App<R>, request: Request, options: Options) =>
  Effect.flatMap(answerCard(request, cardIdentity(app, options), undefined), (card) =>
    card !== undefined
      ? Effect.succeed(card)
      : Effect.flatMap(
          Effect.promise(() => admit(request, options)),
          (admitted) =>
            admitted instanceof Response
              ? Effect.succeed(admitted)
              : Effect.flatMap(Scope.make(), (scope) => respond(app, admitted, options, scope, { polls: undefined, webhooks: undefined, keep: keepNothing })),
        ),
  );

/**
 * A function that answers MCP requests, as `handle`, and keeps the poll leases and the webhook subscriptions in the
 * scope. When the scope closes, they end. A host that builds the services itself provides them to each answer. The
 * services of a request must stay open until the stream of `events/stream` ends, and until each lease and webhook
 * subscription that the request started ends.
 */
export const makeHandle = <R>(app: App.App<R>, options: Options) =>
  Effect.map(Effect.zip(Effect.sync(() => cardIdentity(app, options)), makeDeliveries(options)), ([identity, deliveries]) => (request: Request) =>
    Effect.flatMap(answerCard(request, identity, deliveries.webhooks), (card) =>
      card !== undefined
        ? Effect.succeed(card)
        : Effect.flatMap(
            Effect.promise(() => admit(request, options)),
            (admitted) =>
              admitted instanceof Response
                ? Effect.succeed(admitted)
                : Effect.flatMap(Scope.make(), (scope) => respond(app, admitted, options, scope, { ...deliveries, keep: keepNothing })),
          ),
    ),
  );

const cardIdentity = <R>(app: App.App<R>, options: Options): McpServerCardIdentity | undefined =>
  mcpServerCardIdentity(options.serverCard, options.version, app.description, publishesOnServerCard(options.webhooks));

const answerCard = (request: Request, identity: McpServerCardIdentity | undefined, webhooks: Webhooks | undefined): Effect.Effect<Response | undefined> =>
  Effect.gen(function* () {
    const serverUrl = mcpServerUrlOfCardRequest(request);
    if (serverUrl === undefined) return undefined;
    if (identity === undefined) return request.method === "GET" ? new Response(null, { status: 404 }) : undefined;
    const info = webhooks === undefined ? undefined : yield* webhooks.cardInfo;
    return yield* Effect.promise(() => mcpServerCardResponse(request, mcpServerCard(identity, serverUrl, info)));
  });

interface Admitted {
  readonly request: Request;
  readonly message: unknown;
}

async function admit(request: Request, options: Pick<Options, "allowedOrigins" | "maximumBytes">): Promise<Admitted | Response> {
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
  let message: unknown;
  try {
    message = JSON.parse(body.text);
  } catch {
    return rejection("not-utf8");
  }
  return { request: new Request(request.url, { body: body.text, headers: request.headers, method: "POST", signal: request.signal }), message };
}

const respond = <R>(app: App.App<R>, admitted: Admitted, options: Options, scope: Scope.Closeable, state: Deliveries & { readonly keep: Keep }) =>
  Effect.gen(function* () {
    const sessionOptions = { target: options.target ?? "mcp", eventBuffer: options.eventBuffer };
    const session = yield* Session.make(app, sessionOptions).pipe(Scope.provide(scope));
    const hasEvents = session.view.events !== undefined;
    const request = admitted.request;
    const events = hasEvents ? eventsRequestOf(admitted) : undefined;
    if (events !== undefined) return yield* answerEvents(app, session, events, request, options, scope, state);
    const server = McpServer.layerHttp({
      name: options.name,
      version: options.version,
      instructions: options.instructions ?? app.description,
      path: options.path ?? "/mcp",
      protocols: [McpProtocol.v2026_07_28],
      allowedOrigins: [...options.allowedOrigins],
      ...(hasEvents ? { extensions: McpEvents.EXTENSIONS } : {}),
    });
    const routes = Layer.effectDiscard(registerTools(session, request.signal)).pipe(Layer.provideMerge(server));
    const answer = yield* HttpRouter.toHttpEffect(routes).pipe(Scope.provide(scope));
    // `toHandled` applies the pre-response handlers of `effect/ai`, which set the status 400 of a HeaderMismatch.
    let sent: HttpServerResponse.HttpServerResponse | undefined;
    yield* HttpEffect.toHandled(answer, (_, response) => Effect.sync(() => void (sent = response))).pipe(
      Effect.provideService(HttpServerRequest.HttpServerRequest, HttpServerRequest.fromWeb(request)),
      Scope.provide(scope),
    );
    return sent === undefined ? new Response(null, { status: 500 }) : HttpServerResponse.toWeb(sent);
  }).pipe(closeUnlessStreaming(scope));

const eventsRequestOf = (admitted: Admitted): McpEvents.EventsRequest | undefined =>
  admitted.request.headers.get("MCP-Protocol-Version") === MCP_PROTOCOL_VERSION ? McpEvents.eventsRequestOf(admitted.message) : undefined;

const answerEvents = <R>(
  app: App.App<R>,
  session: Session.Session<R>,
  events: McpEvents.EventsRequest,
  request: Request,
  options: EventsOptions,
  scope: Scope.Closeable,
  state: Deliveries & { readonly keep: Keep },
) =>
  Effect.gen(function* () {
    const sessionOptions = { target: options.target ?? "mcp", eventBuffer: options.eventBuffer };
    const context = yield* Effect.context<R>();
    const open: Opener<R> = (holder) => Effect.andThen(state.keep(holder), Session.make(app, sessionOptions).pipe(Scope.provide(holder), Effect.provideContext(context)));
    const principal = options.principal === undefined ? Option.none() : yield* options.principal(request);
    const answerOptions: McpEvents.AnswerOptions<R> = {
      defaultHeartbeatMs: options.heartbeatMs ?? KEEPALIVE_MS,
      principal,
      polls: state.polls,
      webhooks: state.webhooks,
      open,
    };
    return yield* respondToEvents(session, events, request, answerOptions, scope);
  });

export type EventsOptions = Pick<
  Options,
  "allowedOrigins" | "target" | "maximumBytes" | "services" | "heartbeatMs" | "eventBuffer" | "principal" | "poll" | "webhooks"
>;

/**
 * The `extensions` of the capabilities of a server that serves the events extension. Give them to the server of
 * `effect/ai` that `withEvents` wraps: `McpServer.layerHttp({ …, extensions: Mcp.eventsExtensions })`.
 */
export const eventsExtensions: { readonly [name: string]: JsonObject } = McpEvents.EXTENSIONS;

/**
 * Serve the events of an application beside an MCP server of your own, through HTTP (spec/bindings/mcp.md#events).
 * `server` is the web handler of your server, for example a server of `effect/ai` with your own tools. The result is a
 * web handler for the same URL. It screens each request as `toWebHandler` does. It answers each request of the events
 * extension of revision 2026-07-28 itself, with push, poll and, if `options.webhooks` turns it on, webhook delivery,
 * for the events in the view of `options.target`. It gives each other request to `server`.
 *
 * Your server declares the extension: give it `eventsExtensions` as the `extensions` of its capabilities, so that
 * `server/discover` tells clients that the server serves events. `dispose` ends the poll leases and the webhook
 * subscriptions, and releases the shared services. It does not dispose `server`. With `"per-request"`, the layer can
 * read `Remote.IncomingRequest` and refuse a request of the events extension with a `Remote.Refusal`, as in
 * `toWebHandler`.
 *
 * The result serves no Server Card: a `GET` request to the URL and `/server-card` gets 404. Webhook signing keys or
 * egress ranges need a card, so they make `withEvents` throw.
 */
export function withEvents<R, E>(
  app: App.App<R>,
  layer: Layer.Layer<R, E, IncomingRequest>,
  server: (request: Request) => Promise<Response>,
  options: EventsOptions & { readonly services: "per-request" },
): WebHandler;
export function withEvents<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, server: (request: Request) => Promise<Response>, options: EventsOptions): WebHandler;
export function withEvents<R, E>(
  app: App.App<R>,
  layer: Layer.Layer<R, E, IncomingRequest>,
  server: (request: Request) => Promise<Response>,
  options: EventsOptions,
): WebHandler {
  if (publishesOnServerCard(options.webhooks)) {
    throw new TypeError("withEvents serves no Server Card, and webhook signing keys and egress ranges need one, because a receiver gets them only from the card. Remove the signing keys and the egress ranges.");
  }
  const target = options.target ?? "mcp";
  const hasEvents = viewOf(App.document(app), target).events !== undefined;
  const { answer, dispose: release } = answerWith(layer, options.services);
  const scope = Effect.runSync(Scope.make());
  const deliveries = Effect.runSync(makeDeliveries(options).pipe(Scope.provide(scope)));
  const handler = async (request: Request): Promise<Response> => {
    const card = await Effect.runPromise(answerCard(request, undefined, undefined));
    if (card !== undefined) return card;
    const admitted = await admit(request, options);
    if (admitted instanceof Response) return admitted;
    const events = hasEvents ? eventsRequestOf(admitted) : undefined;
    if (events === undefined) return server(admitted.request);
    return answer(admitted.request, (requestScope, keep) =>
      Effect.gen(function* () {
        const session = yield* Session.make(app, { target, eventBuffer: options.eventBuffer }).pipe(Scope.provide(requestScope));
        return yield* answerEvents(app, session, events, admitted.request, options, requestScope, { ...deliveries, keep });
      }).pipe(closeUnlessStreaming(requestScope)),
    );
  };
  const dispose = async () => {
    await Effect.runPromise(Scope.close(scope, Exit.void));
    await release();
  };
  return Object.assign(handler, { dispose });
}

const respondToEvents = <R>(
  session: Session.Session<R>,
  request: McpEvents.EventsRequest,
  http: Request,
  options: McpEvents.AnswerOptions<R>,
  scope: Scope.Closeable,
): Effect.Effect<Response | Streaming> =>
  Effect.gen(function* () {
    const accepted = (http.headers.get("Accept") ?? "").split(",").map((each) => each.split(";")[0]?.trim().toLowerCase());
    if (!accepted.includes("application/json") || !accepted.includes(SSE_MEDIA_TYPE)) return new Response(null, { status: 406 });
    const mismatch = mcpHeaderMismatch((name) => http.headers.get(name), request.method, request.params, McpEvents.inputSchemaOf(session.view, request.params.name));
    if (mismatch !== undefined) return jsonResponse(400, McpEvents.errorMessage(request.id, { code: MCP_HEADER_MISMATCH, message: mismatch }));
    const answer = yield* McpEvents.answer(session, request, options).pipe(Scope.provide(scope));
    if (answer._tag === "Message") return jsonResponse(200, answer.message);
    const body = answer.messages.pipe(
      Stream.map((each) => sseMessage({ data: JSON.stringify(each) })),
      Stream.encodeText,
      Stream.ensuring(Scope.close(scope, Exit.void)),
      Stream.toReadableStreamWith(yield* Effect.context<never>(), { signal: http.signal }),
    );
    return eventStream(body, http, scope);
  });

const jsonResponse = (status: number, body: JsonObject) =>
  new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });

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
        annotations: mcpToolAnnotations(capability),
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
  /**
   * The time in milliseconds with no message for a subscription after which the server sends
   * `notifications/events/heartbeat`. The default is 15 000.
   */
  readonly heartbeatMs?: number | undefined;
  /** The number of occurrences of one subscription that the session keeps for a slow client. See `Session.Options`. */
  readonly eventBuffer?: number | undefined;
  /** The settings of poll delivery (spec/bindings/mcp.md#poll). The process has no principal. */
  readonly poll?: PollOptions | undefined;
}

type Inbound = { readonly _tag: "Request"; readonly request: McpEvents.EventsRequest } | { readonly _tag: "Cancel"; readonly id: McpEvents.RequestId };

interface EventsInput {
  readonly inbox: Queue.Queue<Inbound>;
  readonly initializes: Set<McpEvents.RequestId>;
}

/**
 * The MCP server through the standard input and output of `Stdio` (spec/bindings/mcp.md#stdio), while the scope of the
 * layer is open. The server is one session. It serves revision 2026-07-28, and the `initialize` handshake of revisions
 * 2025-11-25 and 2025-06-18. The logs of the effects in the layer go to standard error.
 *
 * When the view has events, the server also serves the events extension to clients of revision 2026-07-28. The server
 * of `effect/ai` has no way to add methods, so the binding takes the requests of the extension from standard input
 * before the server reads it, and writes their messages to standard output itself.
 */
export const layerStdio = <R>(app: App.App<R>, options: StdioOptions) =>
  Layer.unwrap(
    Effect.gen(function* () {
      const target = options.target ?? "mcp";
      const hasEvents = viewOf(App.document(app), target).events !== undefined;
      const events: EventsInput | undefined = hasEvents ? { inbox: yield* Queue.unbounded<Inbound>(), initializes: new Set() } : undefined;
      return Layer.effectDiscard(
        Effect.gen(function* () {
          const sessionOptions = { target, eventBuffer: options.eventBuffer };
          const session = yield* Session.make(app, sessionOptions);
          yield* serveTools(session);
          if (events === undefined) return;
          const context = yield* Effect.context<R>();
          const answerOptions: McpEvents.AnswerOptions<R> = {
            defaultHeartbeatMs: options.heartbeatMs ?? KEEPALIVE_MS,
            principal: Option.none(),
            polls: yield* makePolls(options.poll),
            webhooks: undefined,
            open: (holder) => Session.make(app, sessionOptions).pipe(Scope.provide(holder), Effect.provideContext(context)),
          };
          yield* serveEvents(session, events.inbox, answerOptions);
        }),
      ).pipe(
        Layer.provideMerge(
          McpServer.layerStdio({
            name: options.name,
            version: options.version,
            instructions: options.instructions ?? app.description,
            protocols: [McpProtocol.v2026_07_28, McpProtocol.v2025_11_25, McpProtocol.v2025_06_18],
            ...(hasEvents ? { extensions: McpEvents.EXTENSIONS } : {}),
          }),
        ),
        Layer.provide(Layer.effect(Stdio.Stdio, Effect.map(Effect.service(Stdio.Stdio), (stdio) => framed(stdio, events)))),
        // Standard output carries only MCP messages, so the logs go to standard error.
        Layer.provide(Layer.succeed(Logger.LogToStderr, true)),
      );
    }),
  );

const framed = (stdio: Stdio.Stdio, events: EventsInput | undefined): Stdio.Stdio => {
  const parseError = `${JSON.stringify({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "The line is not JSON." } })}\n`;
  const parse = (line: string): { readonly json: unknown } | undefined => {
    try {
      return { json: JSON.parse(line) };
    } catch {
      return undefined;
    }
  };
  const route = (message: unknown): Effect.Effect<boolean> => {
    if (events === undefined || !isJsonObject(message)) return Effect.succeed(true);
    const request = McpEvents.eventsRequestOf(message);
    if (request !== undefined) return Effect.as(Queue.offer(events.inbox, { _tag: "Request", request }), false);
    const params = message.params;
    const cancelled = message.method === "notifications/cancelled" && isJsonObject(params) ? params.requestId : undefined;
    if (typeof cancelled === "string" || typeof cancelled === "number") return Effect.as(Queue.offer(events.inbox, { _tag: "Cancel", id: cancelled }), true);
    if (message.method === "initialize" && (typeof message.id === "string" || typeof message.id === "number")) events.initializes.add(message.id);
    return Effect.succeed(true);
  };
  const stdin = stdio.stdin.pipe(
    Stream.decodeText,
    Stream.splitLines,
    Stream.filter((line) => line.trim() !== ""),
    Stream.filterEffect((line) => {
      const parsed = parse(line);
      return parsed === undefined ? Effect.as(Effect.ignore(Stream.run(Stream.make(parseError), stdio.stdout())), false) : route(parsed.json);
    }),
    Stream.map((line) => `${line}\n`),
    Stream.encodeText,
  );
  if (events === undefined) return Stdio.make({ ...stdio, stdin });
  const stdout: Stdio.Stdio["stdout"] = (options) =>
    stdio.stdout(options).pipe(Sink.mapInput((chunk: string | Uint8Array) => (typeof chunk === "string" ? withoutEventsExtension(chunk, events.initializes) : chunk)));
  return Stdio.make({ ...stdio, stdin, stdout });
};

/**
 * The result of `initialize` gets no `extensions` member for events (spec/bindings/mcp.md#events): the server of
 * `effect/ai` declares the extension for all revisions.
 */
function withoutEventsExtension(chunk: string, initializes: Set<McpEvents.RequestId>): string {
  if (initializes.size === 0) return chunk;
  let message: unknown;
  try {
    message = JSON.parse(chunk);
  } catch {
    return chunk;
  }
  if (!isJsonObject(message) || (typeof message.id !== "string" && typeof message.id !== "number") || !initializes.has(message.id)) return chunk;
  initializes.delete(message.id);
  const result = message.result;
  const capabilities = isJsonObject(result) ? result.capabilities : undefined;
  const extensions = isJsonObject(capabilities) ? capabilities.extensions : undefined;
  if (!isJsonObject(result) || !isJsonObject(capabilities) || !isJsonObject(extensions) || !(MCP_EVENTS_EXTENSION in extensions)) return chunk;
  const { [MCP_EVENTS_EXTENSION]: _, ...others } = extensions;
  const { extensions: __, ...rest } = capabilities;
  const kept = Object.keys(others).length === 0 ? rest : { ...rest, extensions: others };
  return `${JSON.stringify({ ...message, result: { ...result, capabilities: kept } })}\n`;
}

const serveEvents = <R>(session: Session.Session<R>, inbox: Queue.Queue<Inbound>, answerOptions: McpEvents.AnswerOptions<R>) =>
  Effect.gen(function* () {
    const stdio = yield* Stdio.Stdio;
    const lock = yield* Semaphore.make(1);
    const write = (message: JsonObject) => lock.withPermit(Effect.ignore(Stream.run(Stream.make(`${JSON.stringify(message)}\n`), stdio.stdout())));
    const subscriptions = yield* FiberMap.make<string>();
    const keyOf = (id: McpEvents.RequestId) => `${typeof id}:${id}`;
    yield* Queue.take(inbox).pipe(
      Effect.flatMap((inbound) => {
        if (inbound._tag === "Cancel") return FiberMap.remove(subscriptions, keyOf(inbound.id));
        const answered = McpEvents.answer(session, inbound.request, answerOptions).pipe(
          Effect.flatMap((answer) => (answer._tag === "Message" ? write(answer.message) : Stream.runForEach(answer.messages, write))),
          Effect.scoped,
        );
        return Effect.asVoid(FiberMap.run(subscriptions, keyOf(inbound.request.id), answered));
      }),
      Effect.forever,
      Effect.forkScoped({ startImmediately: true }),
    );
  });

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
    // The server of `effect/ai` interrupts its own fiber when it stops writing standard output. That is a normal end too.
    const fiber = yield* Effect.forkChild(Layer.launch(server), { startImmediately: true });
    yield* Effect.raceFirst(Effect.asVoid(Fiber.await(fiber)), Deferred.await(ended));
    yield* Fiber.interrupt(fiber);
    const exit = yield* Fiber.await(fiber);
    if (Exit.isFailure(exit) && !Cause.hasInterruptsOnly(exit.cause)) return yield* Effect.failCause(exit.cause);
  });

const serveTools = (session: Session.Session) =>
  Effect.gen(function* () {
    const server = yield* McpServer.McpServer;
    const refs = refsOf(session);
    const ids = Object.keys(session.view.capabilities);
    const isAvailable = (id: string) => {
      const ref = refs.availability(id);
      return ref === undefined || SubscriptionRef.getUnsafe(ref).available;
    };
    const seen = new Map(ids.map((id) => [id, isAvailable(id)]));
    const seenIds = () => ids.filter((id) => seen.get(id) === true).join("\n");
    let listed = seenIds();
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
