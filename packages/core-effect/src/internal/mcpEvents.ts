/**
 * The MCP events extension (spec/bindings/mcp.md#events), apart from the transports: the answer to each `events/*`
 * request, as one JSON-RPC message or as a stream of JSON-RPC messages.
 */
import {
  bundle,
  isJsonObject,
  MCP_EVENT_ERRORS,
  MCP_EVENTS_EXTENSION,
  MCP_PROTOCOL_VERSION,
  MCP_SUBSCRIPTION_ID,
  mcpEventEntry,
  mcpEventParams,
  mcpSubscribeError,
} from "@acid-cat/spec-ts";
import type { CallFailure, JsonObject, Occurrence } from "@acid-cat/spec-ts";
import { Effect, Schema, Stream } from "effect";
import type { Option, Scope } from "effect";

import type * as Session from "../Session.ts";
import { withHeartbeat } from "./idle.ts";
import type { Opener, Polls } from "./poll.ts";
import type { Webhooks } from "./webhooks.ts";

/** The methods of the events extension that the binding answers. */
const METHODS = new Set(["events/list", "events/stream", "events/poll", "events/subscribe", "events/unsubscribe"]);

/** The methods of the events extension that name an event in `params.name`, and so in the `Mcp-Name` header. */
export const NAMED_METHODS = new Set(["events/stream", "events/poll", "events/subscribe", "events/unsubscribe"]);

/** The capabilities member that tells a client of revision 2026-07-28 that the server serves events. */
export const EXTENSIONS = { [MCP_EVENTS_EXTENSION]: {} };

/** The id of a JSON-RPC request. */
export type RequestId = string | number;

/** A request of the events extension, in revision 2026-07-28. */
export interface EventsRequest {
  readonly id: RequestId;
  readonly method: string;
  readonly params: JsonObject;
}

/**
 * The request of the events extension in a JSON-RPC message, or `undefined`. A request of the extension is a request
 * with an id, of revision 2026-07-28, whose method is one that the binding answers. A client of an earlier revision
 * gets no events, so its requests go to the server of `effect/ai`, which does not know the methods.
 */
export function eventsRequestOf(message: unknown): EventsRequest | undefined {
  if (!isJsonObject(message) || typeof message.method !== "string" || !METHODS.has(message.method)) return undefined;
  const id = message.id;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  const params = message.params === undefined ? {} : message.params;
  if (!isJsonObject(params)) return undefined;
  const meta = params._meta;
  if (!isJsonObject(meta) || meta["io.modelcontextprotocol/protocolVersion"] !== MCP_PROTOCOL_VERSION) return undefined;
  return { id, method: message.method, params };
}

/** The answer to a request: one message, or the messages of a stream. */
export type Answer =
  | { readonly _tag: "Message"; readonly message: JsonObject }
  | { readonly _tag: "Stream"; readonly messages: Stream.Stream<JsonObject> };

export interface AnswerOptions<R> {
  /** The time in milliseconds with no message on a stream after which the server sends a heartbeat. */
  readonly heartbeatMs: number;
  /** The identity of the client of the request, if the deployment gives one. */
  readonly principal: Option.Option<string>;
  /** The poll leases of the server. With none, the server keeps no state, and `events/poll` is unsupported. */
  readonly polls: Polls | undefined;
  /** The webhook subscriptions of the server. With none, webhook delivery is off. */
  readonly webhooks: Webhooks | undefined;
  /** Open a session of its own for a poll lease or a webhook subscription, with the services of the request. */
  readonly open: Opener<R>;
}

const message = (body: JsonObject): Answer => ({ _tag: "Message", message: { jsonrpc: "2.0", ...body } });

export const errorMessage = (id: RequestId | null, error: { readonly code: number; readonly message: string; readonly data?: JsonObject }): JsonObject => ({
  jsonrpc: "2.0",
  id,
  error,
});

const StreamParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Unknown),
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  maxAgeMs: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(0)))),
});
const decodeStreamParams = Schema.decodeUnknownEffect(StreamParams);

const PollParams = Schema.Struct({
  ...StreamParams.fields,
  maxEvents: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
});
const decodePollParams = Schema.decodeUnknownEffect(PollParams);

/** A result or an error of the extension, as a JSON-RPC message. */
const outcomeMessage = (id: RequestId, outcome: { readonly result: JsonObject } | { readonly error: { readonly code: number; readonly message: string; readonly data?: JsonObject } }): Answer =>
  "result" in outcome ? message({ id, result: outcome.result }) : message(errorMessage(id, outcome.error));

/**
 * Answer a request of the events extension for a session whose view has events. A subscription lives in the scope of
 * the answer: close the scope to cancel it.
 */
export const answer = <R>(session: Session.Session<R>, request: EventsRequest, options: AnswerOptions<R>): Effect.Effect<Answer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const view = session.view;
    const types = view.$defs ?? {};
    switch (request.method) {
      case "events/list":
        return message({
          id: request.id,
          result: {
            resultType: "complete",
            events: Object.entries(view.events ?? {}).map(([id, event]) => {
              const entry = mcpEventEntry(
                id,
                event.description,
                event.input === undefined ? undefined : bundle(event.input, types),
                event.payload === undefined ? undefined : bundle(event.payload, types),
                options.webhooks !== undefined,
              );
              return options.polls === undefined ? { ...entry, delivery: ["push"] } : entry;
            }),
          },
        });
      case "events/poll": {
        if (options.polls === undefined) return message(unsupported(request.id, "poll"));
        const params = yield* Effect.result(decodePollParams(request.params));
        if (params._tag === "Failure") {
          return message(errorMessage(request.id, { code: MCP_EVENT_ERRORS.invalidParams, message: `The params of events/poll are not valid: ${params.failure.message}` }));
        }
        const { name, cursor, maxAgeMs, maxEvents } = params.success;
        const polled = yield* options.polls.poll(
          {
            name,
            input: params.success.arguments ?? {},
            cursor: typeof cursor === "string" ? cursor : undefined,
            maxAgeMs: typeof maxAgeMs === "number" ? maxAgeMs : undefined,
            maxEvents: typeof maxEvents === "number" ? maxEvents : undefined,
          },
          options.principal,
          options.open,
        );
        return outcomeMessage(request.id, polled);
      }
      case "events/subscribe":
        if (options.webhooks === undefined) return message(unsupported(request.id, "webhook"));
        return outcomeMessage(request.id, yield* options.webhooks.subscribe(request.params, options.principal, options.open));
      case "events/unsubscribe":
        if (options.webhooks === undefined) return message(unsupported(request.id, "webhook"));
        return outcomeMessage(request.id, yield* options.webhooks.unsubscribe(request.params, options.principal));
    }
    const params = yield* Effect.result(decodeStreamParams(request.params));
    if (params._tag === "Failure") {
      return message(errorMessage(request.id, { code: MCP_EVENT_ERRORS.invalidParams, message: `The params of events/stream are not valid: ${params.failure.message}` }));
    }
    const { name, cursor, maxAgeMs } = params.success;
    const started = yield* Effect.result(
      session.subscribe(name, params.success.arguments ?? {}, {
        ...(typeof cursor === "string" ? { cursor } : {}),
        ...(typeof maxAgeMs === "number" ? { maxAgeMs } : {}),
      }),
    );
    if (started._tag === "Failure") {
      const failure: CallFailure = { kind: started.failure.kind, message: started.failure.message };
      return message(errorMessage(request.id, mcpSubscribeError(failure)));
    }
    return { _tag: "Stream", messages: streamMessages(request.id, started.success, options) };
  });

function unsupported(id: RequestId, mode: "poll" | "webhook"): JsonObject {
  return errorMessage(id, {
    code: MCP_EVENT_ERRORS.unsupported,
    message: mode === "poll" ? "This server keeps no state between requests, so it does not deliver events with poll." : "This server does not deliver events with webhooks.",
    data: { feature: "deliveryMode", value: mode },
  });
}

/**
 * The messages of a subscription that started: `notifications/events/active`, one `notifications/events/event` for
 * each occurrence, heartbeats, and the result of `events/stream` at the end. The call failure `internal` sends
 * `notifications/events/terminated` before the result.
 */
function streamMessages(id: RequestId, occurrences: Session.Subscription<unknown>, options: { readonly heartbeatMs: number }): Stream.Stream<JsonObject> {
  const meta = { [MCP_SUBSCRIPTION_ID]: id };
  const notification = (method: string, params: JsonObject): JsonObject => ({ jsonrpc: "2.0", method, params: { ...params, _meta: meta } });
  let cursor: string | null = null;
  const forOccurrence = (occurrence: Occurrence): readonly JsonObject[] => {
    if (occurrence.cursor !== undefined) cursor = occurrence.cursor;
    const event: JsonObject = { jsonrpc: "2.0", method: "notifications/events/event", params: mcpEventParams(occurrence, id) };
    if (occurrence.truncated !== true) return [event];
    const active = notification("notifications/events/active", { truncated: true, ...(occurrence.cursor === undefined ? {} : { cursor: occurrence.cursor }) });
    return [active, event];
  };
  const result: JsonObject = { jsonrpc: "2.0", id, result: { resultType: "complete", _meta: meta } };
  const events = Stream.flatMap(occurrences, (occurrence) => Stream.fromIterable(forOccurrence(occurrence))).pipe(
    Stream.catchTag("CallFailed", (failure) =>
      Stream.make(notification("notifications/events/terminated", { error: { code: MCP_EVENT_ERRORS.internal, message: failure.message } })),
    ),
  );
  const beating = withHeartbeat(events, options.heartbeatMs, () => notification("notifications/events/heartbeat", { cursor }));
  return Stream.concat(Stream.make(notification("notifications/events/active", { truncated: false })), Stream.concat(beating, Stream.make(result)));
}
