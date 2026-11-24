import {
  bundle,
  isJsonObject,
  MCP_EVENT_ERRORS,
  MCP_EVENTS_EXTENSION,
  MCP_PROTOCOL_VERSION,
  MCP_PROTOCOL_VERSION_KEY,
  MCP_SUBSCRIPTION_ID,
  mcpEventEntry,
  mcpEventParams,
  mcpHeartbeatGrant,
  mcpSubscribeError,
} from "@acid-cat/spec-ts";
import type { CallFailure, CatalogDocument, JsonObject, Occurrence } from "@acid-cat/spec-ts";
import { Effect, Schema, Stream } from "effect";
import type { Option, Scope } from "effect";

import type * as Session from "../Session.ts";
import { withHeartbeat } from "./idle.ts";
import type { Opener, Polls } from "./poll.ts";
import { maxAgeFailure, maxAgeOf, resumeOf } from "./resume.ts";
import type { Webhooks } from "./webhooks.ts";

const METHODS = new Set(["events/list", "events/stream", "events/poll", "events/subscribe", "events/unsubscribe"]);

/** The capabilities member that tells a client of revision 2026-07-28 that the server serves events. */
export const EXTENSIONS = { [MCP_EVENTS_EXTENSION]: {} };

export type RequestId = string | number;

export interface EventsRequest {
  readonly id: RequestId;
  readonly method: string;
  readonly params: JsonObject;
}

/**
 * The request of the events extension in a JSON-RPC message, or `undefined`. A request of the extension is a request
 * with an id, of revision 2026-07-28, whose method is one that the surface answers. A client of an earlier revision
 * gets no events, so its requests go to the server of `effect/ai`, which does not know the methods.
 */
export function eventsRequestOf(message: unknown): EventsRequest | undefined {
  if (!isJsonObject(message) || typeof message.method !== "string" || !METHODS.has(message.method)) return undefined;
  const id = message.id;
  if (typeof id !== "string" && typeof id !== "number") return undefined;
  const params = message.params === undefined ? {} : message.params;
  if (!isJsonObject(params)) return undefined;
  const meta = params._meta;
  if (!isJsonObject(meta) || meta[MCP_PROTOCOL_VERSION_KEY] !== MCP_PROTOCOL_VERSION) return undefined;
  return { id, method: message.method, params };
}

export function inputSchemaOf(catalog: CatalogDocument, name: unknown): JsonObject | undefined {
  const events = catalog.events ?? {};
  const input = typeof name === "string" && Object.hasOwn(events, name) ? events[name]?.input : undefined;
  return input === undefined ? undefined : bundle(input, catalog.$defs ?? {});
}

export type Answer =
  | { readonly _tag: "Message"; readonly message: JsonObject }
  | { readonly _tag: "Stream"; readonly messages: Stream.Stream<JsonObject> };

export interface AnswerOptions<R> {
  readonly defaultHeartbeatMs: number;
  readonly principal: Option.Option<string>;
  readonly polls: Polls | undefined;
  readonly webhooks: Webhooks | undefined;
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
  // Any value: an unknown name comes before an invalid `maxAgeMs` (spec/events.md#subscribing).
  maxAgeMs: Schema.optionalKey(Schema.Unknown),
});
const decodeStreamParams = Schema.decodeUnknownEffect(
  Schema.Struct({ ...StreamParams.fields, heartbeatMs: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))) }),
);

const PollParams = Schema.Struct({
  ...StreamParams.fields,
  maxEvents: Schema.optionalKey(Schema.NullOr(Schema.Int.check(Schema.isGreaterThanOrEqualTo(1)))),
});
const decodePollParams = Schema.decodeUnknownEffect(PollParams);

const outcomeMessage = (id: RequestId, outcome: { readonly result: JsonObject } | { readonly error: { readonly code: number; readonly message: string; readonly data?: JsonObject } }): Answer =>
  "result" in outcome ? message({ id, result: outcome.result }) : message(errorMessage(id, outcome.error));

export const answer = <R>(session: Session.Session<R>, request: EventsRequest, options: AnswerOptions<R>): Effect.Effect<Answer, never, Scope.Scope> =>
  Effect.gen(function* () {
    const catalog = session.catalog;
    const types = catalog.$defs ?? {};
    switch (request.method) {
      case "events/list":
        return message({
          id: request.id,
          result: {
            resultType: "complete",
            events: Object.entries(catalog.events ?? {}).map(([id, event]) => {
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
        const { name, cursor, maxEvents } = params.success;
        const maxAge = maxAgeOf(params.success.maxAgeMs);
        if (maxAge._tag === "Invalid") return message(errorMessage(request.id, mcpSubscribeError(maxAgeFailure(catalog.events, name, maxAge.issue))));
        const polled = yield* options.polls.poll(
          {
            name,
            input: params.success.arguments ?? {},
            cursor: typeof cursor === "string" ? cursor : undefined,
            maxAgeMs: maxAge._tag === "Valid" ? maxAge.maxAgeMs : undefined,
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
    const { name, cursor } = params.success;
    const maxAge = maxAgeOf(params.success.maxAgeMs);
    const started = yield* Effect.result(session.subscribe(name, params.success.arguments ?? {}, resumeOf(cursor, maxAge)));
    if (started._tag === "Failure") {
      const failure: CallFailure = { kind: started.failure.kind, message: started.failure.message };
      return message(errorMessage(request.id, mcpSubscribeError(failure)));
    }
    const heartbeatMs = mcpHeartbeatGrant(params.success.heartbeatMs, options.defaultHeartbeatMs);
    return { _tag: "Stream", messages: streamMessages(request.id, started.success, heartbeatMs) };
  });

function unsupported(id: RequestId, mode: "poll" | "webhook"): JsonObject {
  return errorMessage(id, {
    code: MCP_EVENT_ERRORS.unsupported,
    message: mode === "poll" ? "This server keeps no state between requests, so it does not deliver events with poll." : "This server does not deliver events with webhooks.",
    data: { feature: "deliveryMode", value: mode },
  });
}

function streamMessages(id: RequestId, occurrences: Session.Subscription<unknown>, heartbeatMs: number): Stream.Stream<JsonObject> {
  const meta = { [MCP_SUBSCRIPTION_ID]: id };
  const notification = (method: string, params: JsonObject): JsonObject => ({ jsonrpc: "2.0", method, params: { ...params, _meta: meta } });
  let cursor: string | null = null;
  const forOccurrence = (occurrence: Occurrence): readonly JsonObject[] => {
    if (occurrence.cursor !== undefined) cursor = occurrence.cursor;
    const event: JsonObject = { jsonrpc: "2.0", method: "notifications/events/event", params: mcpEventParams(occurrence, id) };
    if (occurrence.truncated !== true) return [event];
    const active = notification("notifications/events/active", { truncated: true, ...(occurrence.cursor === undefined ? {} : { cursor: occurrence.cursor }), heartbeatMs });
    return [active, event];
  };
  const result: JsonObject = { jsonrpc: "2.0", id, result: { resultType: "complete", _meta: meta } };
  const events = Stream.flatMap(occurrences, (occurrence) => Stream.fromIterable(forOccurrence(occurrence))).pipe(
    Stream.catchTag("CallFailed", (failure) =>
      Stream.make(notification("notifications/events/terminated", { error: { code: MCP_EVENT_ERRORS.internal, message: failure.message } })),
    ),
  );
  const beating = withHeartbeat(events, heartbeatMs, () => notification("notifications/events/heartbeat", { cursor }));
  return Stream.concat(Stream.make(notification("notifications/events/active", { truncated: false, heartbeatMs })), Stream.concat(beating, Stream.make(result)));
}
