/**
 * Events through MCP (spec/bindings/mcp.md#events): the MCP events extension, with push delivery. The HTTP and the stdio
 * transports share these functions.
 */
import { bundle, CallFailureError, MCP_EVENT_ERRORS, MCP_EVENTS_EXTENSION, MCP_SUBSCRIPTION_ID, mcpEventEntry, mcpEventParams, mcpSubscribeError } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import type { Session } from "./session.ts";
import { idlePuller } from "./stream.ts";

/** A JSON-RPC error. */
export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonObject;
}

/** True if the view of the session has events. The server serves the extension only then. */
export const servesEvents = (session: Session): boolean => Object.keys(session.view.events ?? {}).length > 0;

/** The members that the capabilities of `server/discover` get for events: the extension, if the view has events. */
export const eventCapabilities = (session: Session): JsonObject => (servesEvents(session) ? { extensions: { [MCP_EVENTS_EXTENSION]: {} } } : {});

/** The entries of `events/list`: one for each event in the view. */
export function listEvents(session: Session): JsonObject[] {
  const types = session.view.$defs ?? {};
  return Object.entries(session.view.events ?? {}).map(([id, event]) =>
    mcpEventEntry(id, event.description, event.input === undefined ? undefined : bundle(event.input, types), event.payload === undefined ? undefined : bundle(event.payload, types)),
  );
}

/** The error of `events/poll` and `events/subscribe`: the server serves only push delivery. */
export function unsupportedDelivery(method: "events/poll" | "events/subscribe"): JsonRpcError {
  return { code: MCP_EVENT_ERRORS.unsupported, message: "Unsupported", data: { feature: "deliveryMode", value: method === "events/poll" ? "poll" : "webhook" } };
}

/**
 * The messages of one `events/stream` request, as a function that gives the next messages each time that it is called,
 * or `undefined` after the result. `id` is the id of the request.
 */
export type StreamMessages = () => Promise<readonly JsonObject[] | undefined>;

export interface StreamSettings {
  /** The time with nothing sent after which the server sends a heartbeat, in milliseconds. */
  readonly heartbeatMs: number;
  /** The `_meta` members of the result beside the subscription id, for example the server information. */
  readonly resultMeta: JsonObject;
  readonly signal: AbortSignal;
}

/**
 * Start the subscription of an `events/stream` request. The result is the JSON-RPC error before the first occurrence,
 * or the messages of the stream: `notifications/events/active`, then the occurrences and the heartbeats, then the
 * result. `cancel` cancels the subscription.
 */
export async function startEventStream(session: Session, id: string | number, params: JsonObject, settings: StreamSettings): Promise<{ readonly error: JsonRpcError } | { readonly messages: StreamMessages; readonly cancel: () => void }> {
  const { name, arguments: input, cursor, maxAgeMs } = params;
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") return { error: { code: MCP_EVENT_ERRORS.invalidParams, message: "cursor must be a string or null." } };
  if (maxAgeMs !== undefined && maxAgeMs !== null && (typeof maxAgeMs !== "number" || !Number.isFinite(maxAgeMs) || maxAgeMs < 0)) {
    return { error: { code: MCP_EVENT_ERRORS.invalidParams, message: "maxAgeMs must be a number of milliseconds." } };
  }
  const subscribed = await session.subscribe(typeof name === "string" ? name : "", input ?? {}, {
    signal: settings.signal,
    ...(typeof cursor === "string" ? { cursor } : {}),
    ...(typeof maxAgeMs === "number" ? { maxAgeMs } : {}),
  });
  if ("kind" in subscribed) return { error: mcpSubscribeError(subscribed) };

  const meta = { [MCP_SUBSCRIPTION_ID]: id };
  const notification = (method: string, members: JsonObject): JsonObject => ({ jsonrpc: "2.0", method: `notifications/events/${method}`, params: { ...members, _meta: meta } });
  const result: JsonObject = { jsonrpc: "2.0", id, result: { resultType: "complete", _meta: { ...settings.resultMeta, ...meta } } };
  const pull = idlePuller(subscribed, settings.heartbeatMs);
  let state: "start" | "open" | "ended" = "start";
  let lastCursor: string | null = null;

  const messages: StreamMessages = async () => {
    if (state === "ended") return undefined;
    if (state === "start") {
      state = "open";
      return [notification("active", { truncated: false })];
    }
    const pulled = await pull();
    if ("idle" in pulled) return [notification("heartbeat", { cursor: lastCursor })];
    if ("error" in pulled) {
      state = "ended";
      const message = pulled.error instanceof CallFailureError ? pulled.error.message : "The event failed.";
      return [notification("terminated", { error: { code: MCP_EVENT_ERRORS.internal, message } }), result];
    }
    if (pulled.step.done === true) {
      state = "ended";
      return [result];
    }
    const occurrence = pulled.step.value;
    if (occurrence.cursor !== undefined) lastCursor = occurrence.cursor;
    const event: JsonObject = { jsonrpc: "2.0", method: "notifications/events/event", params: mcpEventParams(occurrence, id) };
    if (occurrence.truncated !== true) return [event];
    return [notification("active", { truncated: true, ...(occurrence.cursor === undefined ? {} : { cursor: occurrence.cursor }) }), event];
  };
  return { messages, cancel: () => void subscribed.return() };
}
