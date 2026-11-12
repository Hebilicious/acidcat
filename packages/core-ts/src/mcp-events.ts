/**
 * Events through MCP (spec/bindings/mcp.md#events): the MCP events extension. This module serves push delivery, and
 * declares the parts that poll and webhook delivery share. The HTTP and the stdio transports share these functions.
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

/** The entries of `events/list`: one for each event in the view. `webhook` is true when webhook delivery is on. */
export function listEvents(session: Session, webhook = false): JsonObject[] {
  const types = session.view.$defs ?? {};
  return Object.entries(session.view.events ?? {}).map(([id, event]) =>
    mcpEventEntry(
      id,
      event.description,
      event.input === undefined ? undefined : bundle(event.input, types),
      event.payload === undefined ? undefined : bundle(event.payload, types),
      webhook,
    ),
  );
}

/** The error of `events/subscribe` and `events/unsubscribe` when webhook delivery is off, or through stdio. */
export const unsupportedWebhook: JsonRpcError = { code: MCP_EVENT_ERRORS.unsupported, message: "Unsupported", data: { feature: "deliveryMode", value: "webhook" } };

/** The answer to a request: its result, with no `resultType` and no `_meta`, or a JSON-RPC error. */
export type RpcAnswer = { readonly result: JsonObject } | { readonly error: JsonRpcError };

/**
 * A session of its own for a poll lease or a webhook subscription (spec/bindings/mcp.md#subscriptions-that-outlive-a-request).
 * `close` closes the session, and releases its context. A second call does nothing more.
 */
export interface OwnSession {
  readonly session: Session;
  readonly close: () => Promise<void>;
}

/** Open a session of its own, with the identity and the services of the request that starts the lease or the subscription. */
export type OpenSession = () => Promise<OwnSession>;

/**
 * Webhook delivery (spec/bindings/mcp.md#webhook), as the MCP server through HTTP uses it. `webhookDelivery` of
 * `@acid-cat/core-ts/node` makes one. The server checks the principal before it calls these functions.
 */
export interface WebhookDelivery {
  /** Answer `events/subscribe`. */
  readonly subscribe: (principal: string, params: JsonObject, open: OpenSession) => Promise<RpcAnswer>;
  /** Answer `events/unsubscribe`. */
  readonly unsubscribe: (principal: string, params: JsonObject) => Promise<RpcAnswer>;
  /** End all webhook subscriptions. */
  readonly close: () => Promise<void>;
}

/** The error `Forbidden`: a request to `events/subscribe` or `events/unsubscribe` with no principal. */
export const forbidden: JsonRpcError = { code: MCP_EVENT_ERRORS.forbidden, message: "Forbidden" };

/** The error `-32602` with a message. */
export const invalidParams = (message: string): { readonly error: JsonRpcError } => ({ error: { code: MCP_EVENT_ERRORS.invalidParams, message } });

/**
 * Read the subscription parameters (spec/bindings/mcp.md#events): the id, the input, the cursor and `maxAgeMs`. An
 * absent cursor and a `null` cursor are the same. The input is `{}` when `arguments` is absent.
 *
 * This function does not check `maxAgeMs`: an unknown id comes before an invalid `maxAgeMs` (spec/events.md#subscribing),
 * so the session checks it after the id. A `maxAgeMs` that is not a number is `NaN`, which the session rejects.
 */
export function subscriptionParams(params: JsonObject): { readonly error: JsonRpcError } | { readonly name: string; readonly input: unknown; readonly cursor: string | undefined; readonly maxAgeMs: number | undefined } {
  const { name, arguments: input, cursor, maxAgeMs } = params;
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") return invalidParams("cursor must be a string or null.");
  return {
    name: typeof name === "string" ? name : "",
    input: input ?? {},
    cursor: typeof cursor === "string" ? cursor : undefined,
    maxAgeMs: maxAgeMs === undefined || maxAgeMs === null ? undefined : typeof maxAgeMs === "number" ? maxAgeMs : Number.NaN,
  };
}

/** The message of the call failure that ends a subscription. A subscription ends only with `internal`. */
export const endMessage = (error: unknown): string => (error instanceof CallFailureError ? error.message : "The event failed.");

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
  const read = subscriptionParams(params);
  if ("error" in read) return read;
  const { cursor, maxAgeMs } = read;
  const subscribed = await session.subscribe(read.name, read.input, {
    signal: settings.signal,
    ...(cursor === undefined ? {} : { cursor }),
    ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
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
      return [notification("terminated", { error: { code: MCP_EVENT_ERRORS.internal, message: endMessage(pulled.error) } }), result];
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
