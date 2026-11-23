import { bundle, CallFailureError, isMcpHeartbeatSuggestion, MCP_EVENT_ERRORS, MCP_EVENTS_EXTENSION, MCP_SUBSCRIPTION_ID, mcpEventEntry, mcpEventParams, mcpHeartbeatGrant, mcpSubscribeError } from "@acid-cat/spec-ts";
import type { JsonObject } from "@acid-cat/spec-ts";

import { maxAgeOf, subscribeWithMaxAge } from "./session.ts";
import type { MaxAge, Session } from "./session.ts";
import { idlePuller } from "./stream.ts";

export interface JsonRpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonObject;
}

export const servesEvents = (session: Session): boolean => Object.keys(session.view.events ?? {}).length > 0;

export const eventCapabilities = (session: Session): JsonObject => (servesEvents(session) ? { extensions: { [MCP_EVENTS_EXTENSION]: {} } } : {});

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
  readonly subscribe: (principal: string, params: JsonObject, open: OpenSession) => Promise<RpcAnswer>;
  readonly unsubscribe: (principal: string, params: JsonObject) => Promise<RpcAnswer>;
  readonly close: () => Promise<void>;
}

export const forbidden: JsonRpcError = { code: MCP_EVENT_ERRORS.forbidden, message: "Forbidden" };

export const invalidParams = (message: string): { readonly error: JsonRpcError } => ({ error: { code: MCP_EVENT_ERRORS.invalidParams, message } });

/**
 * This function does not reject an invalid `maxAgeMs`: an unknown id comes before an invalid `maxAgeMs`
 * (spec/events.md#subscribing), so `subscribeWithMaxAge` rejects it after the id.
 */
export function subscriptionParams(params: JsonObject): { readonly error: JsonRpcError } | { readonly name: string; readonly input: unknown; readonly cursor: string | undefined; readonly maxAge: MaxAge } {
  const { name, arguments: input, cursor, maxAgeMs } = params;
  if (cursor !== undefined && cursor !== null && typeof cursor !== "string") return invalidParams("cursor must be a string or null.");
  return {
    name: typeof name === "string" ? name : "",
    input: input ?? {},
    cursor: typeof cursor === "string" ? cursor : undefined,
    maxAge: maxAgeOf(maxAgeMs),
  };
}

export const endMessage = (error: unknown): string => (error instanceof CallFailureError ? error.message : "The event failed.");

export type StreamMessages = () => Promise<readonly JsonObject[] | undefined>;

export interface StreamSettings {
  readonly defaultHeartbeatMs: number;
  readonly resultMeta: JsonObject;
  readonly signal: AbortSignal;
}

export async function startEventStream(session: Session, id: string | number, params: JsonObject, settings: StreamSettings): Promise<{ readonly error: JsonRpcError } | { readonly messages: StreamMessages; readonly cancel: () => void }> {
  const read = subscriptionParams(params);
  if ("error" in read) return read;
  const suggestion = params["heartbeatMs"];
  if (!isMcpHeartbeatSuggestion(suggestion)) return invalidParams("heartbeatMs must be a positive integer or null.");
  const heartbeatMs = mcpHeartbeatGrant(suggestion, settings.defaultHeartbeatMs);
  const subscribed = await subscribeWithMaxAge(session, read.name, read.input, { signal: settings.signal, cursor: read.cursor, maxAge: read.maxAge });
  if ("kind" in subscribed) return { error: mcpSubscribeError(subscribed) };

  const meta = { [MCP_SUBSCRIPTION_ID]: id };
  const notification = (method: string, members: JsonObject): JsonObject => ({ jsonrpc: "2.0", method: `notifications/events/${method}`, params: { ...members, _meta: meta } });
  const result: JsonObject = { jsonrpc: "2.0", id, result: { resultType: "complete", _meta: { ...settings.resultMeta, ...meta } } };
  const pull = idlePuller(subscribed, heartbeatMs);
  let state: "start" | "open" | "ended" = "start";
  let lastCursor: string | null = null;

  const messages: StreamMessages = async () => {
    if (state === "ended") return undefined;
    if (state === "start") {
      state = "open";
      return [notification("active", { truncated: false, heartbeatMs })];
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
    return [notification("active", { truncated: true, ...(occurrence.cursor === undefined ? {} : { cursor: occurrence.cursor }), heartbeatMs }), event];
  };
  return { messages, cancel: () => void subscribed.return() };
}
