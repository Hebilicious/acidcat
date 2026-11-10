/**
 * Conformance checks for the MCP binding through HTTP (spec/bindings/mcp.md). The protocol checks use the official MCP
 * client with revision 2026-07-28. With `handshake`, they run again with the `initialize` handshake of revision
 * 2025-11-25. The other checks send requests that a client never sends.
 */
import { randomUUID } from "node:crypto";

import { MCP_EVENTS_EXTENSION, MCP_SUBSCRIPTION_ID } from "@acid-cat/spec-ts";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";

import { isArrayOf, isObject, isStringArray, memberOf, parseJson, readJson } from "../json.ts";
import type { JsonObject } from "../json.ts";
import { Checks, eventIdsOf, expect, expectEqual, expectOccurrence, fixture, FORBIDDEN_ORIGIN, idsOf, sorted, until } from "./check.ts";
import { checkPoll } from "./poll.ts";
import type { PollSettings } from "./poll.ts";
import { sseReader } from "./sse.ts";
import { checkWebhook } from "./webhook.ts";
import type { WebhookSettings } from "./webhook.ts";

const RULE = "spec/bindings/mcp.md";

/** A tool result, as the MCP client gives it. */
type ToolResult = Awaited<ReturnType<Client["callTool"]>>;

/** A connected MCP client. With `handshake`, the client opens the session with `initialize`. */
export async function mcpClient(url: string, signal?: AbortSignal, handshake = false): Promise<Client> {
  const client = new Client({ name: "acid-cat-conform", version: "0.1.0" }, handshake ? { versionNegotiation: { mode: "legacy" } } : { versionNegotiation: { mode: { pin: "2026-07-28" } } });
  await client.connect(new StreamableHTTPClientTransport(new URL(url)), signal ? { signal } : undefined);
  return client;
}

/** The JSON value in the first text content of a tool result, or `null` when there is no text content. */
const textOf = (result: ToolResult): unknown => {
  const first = result.content[0];
  return parseJson(first?.type === "text" ? first.text : "null");
};

export interface McpCheckOptions {
  readonly maximumBytes: number;
  readonly deadline: number;
  readonly handshake: boolean;
  /** The poll settings of the deployment, for the checks of the buffer and of the lease time. */
  readonly poll: PollSettings;
  /** The settings of the checks of webhook delivery. With none, conform does not test webhook delivery. */
  readonly webhook: WebhookSettings | undefined;
}

export async function checkMcp(url: string, options: McpCheckOptions): Promise<Checks> {
  const checks = new Checks("mcp", options.deadline);
  let client: Client | undefined;

  await checks.run("an MCP client connects with revision 2026-07-28", `${RULE}#http`, async (signal) => {
    client = await mcpClient(url, signal);
  });
  if (client === undefined) return checks;
  const mcp = client;
  await checkTools(checks, mcp);
  await mcp.close();

  const post = (signal: AbortSignal, { headers = {}, body }: { readonly headers?: Record<string, string>; readonly body: BodyInit }) =>
    fetch(url, { method: "POST", body, headers: { "Content-Type": "application/json", ...headers }, signal });
  const rejection = async (response: Response, status: number, code?: number) => {
    expectEqual(response.status, status, "status");
    expectEqual(response.headers.get("Cache-Control"), "no-store", "Cache-Control");
    if (code !== undefined) expectEqual(memberOf(memberOf(await readJson(response), "error"), "code"), code, "JSON-RPC error code");
  };

  await checks.run("a method other than POST is rejected with 405", `${RULE}#http`, async (signal) => {
    const response = await fetch(url, { signal });
    await rejection(response, 405);
    expectEqual(response.headers.get("Allow"), "POST", "Allow");
  });
  await checks.run("an origin that is not allowed is rejected with 403", `${RULE}#http`, async (signal) => {
    await rejection(await post(signal, { headers: { Origin: FORBIDDEN_ORIGIN }, body: "{}" }), 403);
  });
  await checks.run("a media type other than JSON is rejected with 415", `${RULE}#http`, async (signal) => {
    await rejection(await post(signal, { headers: { "Content-Type": "text/plain" }, body: "{}" }), 415);
  });
  await checks.run("a body over the limit is rejected with 413 and -32600", `${RULE}#http`, async (signal) => {
    await rejection(await post(signal, { body: " ".repeat(options.maximumBytes + 1) }), 413, -32600);
  });
  await checks.run("a body that is not JSON is rejected with 400 and -32700", `${RULE}#http`, async (signal) => {
    await rejection(await post(signal, { body: "{" }), 400, -32700);
  });
  await checks.run("a body that is not UTF-8 is rejected with 400", `${RULE}#http`, async (signal) => {
    await rejection(await post(signal, { body: new Uint8Array([0x7b, 0xff, 0x7d]) }), 400);
  });

  await checkEvents(checks, httpChannel(url), { transport: "http", poll: options.poll, webhook: options.webhook !== undefined });
  if (options.webhook !== undefined) await checkWebhook(checks, url, options.webhook);
  if (options.handshake) await checkHandshake(checks, url, options.deadline);
  return checks;
}

const ANCHOR = `${RULE}#earlier-revisions-through-http`;

/** The checks of the `initialize` handshake of revision 2025-11-25 (spec/bindings/mcp.md#earlier-revisions-through-http). */
async function checkHandshake(checks: Checks, url: string, deadline: number): Promise<void> {
  const handshakeChecks = new Checks("mcp 2025-11-25", deadline);
  let client: Client | undefined;
  await handshakeChecks.run("an MCP client connects with the initialize handshake of revision 2025-11-25", ANCHOR, async (signal) => {
    client = await mcpClient(url, signal, true);
    expectEqual(client.getNegotiatedProtocolVersion(), "2025-11-25", "the revision of the session");
  });
  if (client !== undefined) {
    await checkTools(handshakeChecks, client);
    await client.close();
  }

  const rpc = (signal: AbortSignal, message: object, version?: string) =>
    fetch(url, {
      method: "POST",
      body: JSON.stringify({ jsonrpc: "2.0", ...message }),
      headers: { "Content-Type": "application/json", ...(version === undefined ? {} : { "MCP-Protocol-Version": version }) },
      signal,
    });
  await handshakeChecks.run("initialize gives the revision of the client, and the server keeps no session", ANCHOR, async (signal) => {
    const response = await rpc(signal, { id: 1, method: "initialize", params: { protocolVersion: "2025-11-25", capabilities: {}, clientInfo: { name: "acid-cat-conform", version: "0.1.0" } } });
    expectEqual(response.status, 200, "status");
    expectEqual(response.headers.get("Mcp-Session-Id"), null, "Mcp-Session-Id");
    const result = memberOf(await readJson(response), "result");
    expectEqual(memberOf(result, "protocolVersion"), "2025-11-25", "protocolVersion");
    const extensions = memberOf(memberOf(result, "capabilities"), "extensions");
    expect(memberOf(extensions, MCP_EVENTS_EXTENSION) === undefined, `the capabilities of initialize must not have the events extension, got ${JSON.stringify(extensions)}`);
  });
  await handshakeChecks.run("a notification of a revision with a handshake gets 202", ANCHOR, async (signal) => {
    expectEqual((await rpc(signal, { method: "notifications/initialized" }, "2025-11-25")).status, 202, "status");
  });
  checks.results.push(...handshakeChecks.results);
}

/**
 * The checks of the tools and their outcomes, through a connected client (spec/bindings/mcp.md#tools). Each transport
 * runs them.
 */
export async function checkTools(checks: Checks, mcp: Client): Promise<void> {
  const call = (signal: AbortSignal, name: string, args: Record<string, unknown>) =>
    mcp.callTool({ name, arguments: args }, { signal });

  await checks.run("the instructions are the description of the catalog", `${RULE}#server`, () => {
    expectEqual(mcp.getInstructions(), fixture.description, "instructions");
  });

  await checks.run("tools/list gives each available capability of the view", `${RULE}#tools`, async (signal) => {
    const { tools } = await mcp.listTools(undefined, { signal });
    expectEqual(sorted(tools.map((tool) => tool.name)), idsOf("mcp"), "tools");
  });

  await checks.run("tools have their hints and output schemas", `${RULE}#tools`, async (signal) => {
    const { tools } = await mcp.listTools(undefined, { signal });
    const echo = tools.find((tool) => tool.name === "fixture.echo");
    const refuse = tools.find((tool) => tool.name === "fixture.refuse");
    expect(echo?.annotations?.readOnlyHint === true, "fixture.echo must have readOnlyHint: true");
    expect(refuse?.annotations?.readOnlyHint !== true, "fixture.refuse must not have readOnlyHint: true");
    expect(echo?.outputSchema?.type === "object", "fixture.echo must have an object outputSchema");
    expect(refuse?.outputSchema === undefined, "fixture.refuse has no object output, so it must have no outputSchema");
    expect(echo?.inputSchema.type === "object", "an inputSchema must be an object");
  });

  await checks.run("a value is a tool result with structured content", `${RULE}#tools`, async (signal) => {
    const result = await call(signal, "fixture.echo", { text: "hello" });
    expect(result.isError !== true, "a value must not be an error result");
    expectEqual(result.structuredContent, { text: "hello" }, "structuredContent");
    expectEqual(textOf(result), { text: "hello" }, "text content");
  });

  await checks.run("a failure is an error result with ok: false", `${RULE}#tools`, async (signal) => {
    const result = await call(signal, "fixture.refuse", {});
    expect(result.isError === true, "a failure must be an error result");
    const body = textOf(result);
    expect(memberOf(body, "ok") === false && memberOf(memberOf(body, "error"), "_tag") === "Refused", `expected { ok: false, error: { _tag: "Refused" } }, got ${JSON.stringify(body)}`);
  });

  await checks.run("a defect is an internal call failure with no internal details", `${RULE}#tools`, async (signal) => {
    const result = await call(signal, "fixture.crash", {});
    const body = textOf(result);
    expect(isObject(body), `expected an object, got ${JSON.stringify(body)}`);
    expect(result.isError === true && body.kind === "internal" && !("ok" in body), `expected { kind: "internal" }, got ${JSON.stringify(body)}`);
    const message = typeof body.message === "string" ? body.message : "";
    expect(!/\n\s+at /.test(message), "the message must not contain a stack trace");
  });

  await checks.run("an input that does not agree with its schema is invalid-input", `${RULE}#tools`, async (signal) => {
    const result = await call(signal, "fixture.echo", { text: 1 });
    expectEqual(memberOf(textOf(result), "kind"), "invalid-input", "kind");
  });

  await checks.run("a capability outside the view is an unknown tool", `${RULE}#tools`, async (signal) => {
    const error = await call(signal, "fixture.hidden", {}).then(
      () => undefined,
      (caught: unknown) => caught,
    );
    expect(memberOf(error, "code") === -32602, `expected the JSON-RPC error -32602, got ${JSON.stringify(error)}`);
  });

  await checks.run("an unavailable capability is not listed", `${RULE}#tools`, async (signal) => {
    await call(signal, "fixture.switch.set", { on: false });
    try {
      const { tools } = await mcp.listTools(undefined, { signal });
      expect(!tools.some((tool) => tool.name === "fixture.toggle"), "fixture.toggle must not be listed while it is unavailable");
    } finally {
      await call(AbortSignal.timeout(checks.deadline), "fixture.switch.set", { on: true });
    }
  });
}

// --- Events ------------------------------------------------------------------------------------------------------

/** The revision of the protocol that serves the events extension. */
export const EVENTS_REVISION = "2026-07-28";

/** The `_meta` of each request of revision 2026-07-28: the revision, and the capabilities of the client, which has none. */
export const META = { "io.modelcontextprotocol/protocolVersion": EVENTS_REVISION, "io.modelcontextprotocol/clientCapabilities": {} };

/** A JSON-RPC message from the server. */
export type Message = JsonObject;

/**
 * The messages of one `events/stream` request: the notifications of the subscription and its response. `next` gives
 * the next message, or `undefined` at the end. `cancel` cancels the subscription, as the transport does.
 */
export interface EventStream {
  next(): Promise<Message | undefined>;
  cancel(): Promise<void>;
}

/** A way to send requests of revision 2026-07-28 to a server: through HTTP, or through standard input and output. */
export interface Channel {
  request(method: string, params: JsonObject, signal: AbortSignal): Promise<Message>;
  /** Start `events/stream` with this request id. */
  stream(id: string, params: JsonObject, signal: AbortSignal): Promise<EventStream>;
}

/** A channel to a server through HTTP. Each request has the `headers` too, for example the credentials of a principal. */
export function httpChannel(url: string, headers: Readonly<Record<string, string>> = {}): Channel {
  const post = (id: string, method: string, params: JsonObject, signal: AbortSignal) =>
    fetch(url, {
      method: "POST",
      headers: {
        ...headers,
        "Content-Type": "application/json",
        Accept: "application/json, text/event-stream",
        "Mcp-Method": method,
        "MCP-Protocol-Version": EVENTS_REVISION,
        ...(typeof params.name === "string" ? { "Mcp-Name": params.name } : {}),
      },
      body: JSON.stringify({ jsonrpc: "2.0", id, method, params: { ...params, _meta: META } }),
      signal,
    });
  /** The messages of a response: one JSON message, or a stream of server-sent events with one message in each. */
  const messagesOf = (response: Response, close: () => void): EventStream => {
    if (response.headers.get("Content-Type")?.startsWith("text/event-stream") !== true) {
      let read = false;
      return {
        next: async () => {
          if (read) return undefined;
          read = true;
          const message = await readJson(response);
          expect(isObject(message), `expected a JSON-RPC message, got ${JSON.stringify(message)}`);
          return message;
        },
        cancel: async () => close(),
      };
    }
    const reader = sseReader(response);
    return {
      next: async () => {
        const event = await reader.next();
        if (event === undefined) return undefined;
        const message = parseJson(event.data);
        expect(isObject(message), `each server-sent event must hold one JSON-RPC message, got ${JSON.stringify(event.data)}`);
        return message;
      },
      cancel: async () => close(),
    };
  };
  let next = 0;
  return {
    async request(method, params, signal) {
      const response = await post(`conform-${(next += 1)}`, method, params, signal);
      const message = await messagesOf(response, () => undefined).next();
      if (message === undefined) throw new Error(`the response to ${method} has no message`);
      return message;
    },
    async stream(id, params, signal) {
      const controller = new AbortController();
      const response = await post(id, "events/stream", params, AbortSignal.any([signal, controller.signal]));
      return messagesOf(response, () => controller.abort());
    },
  };
}

/** The subscription id in the `_meta` of the params of a notification, or of a result. */
export const subscriptionOf = (message: Message): unknown => memberOf(memberOf(memberOf(message, "params") ?? memberOf(message, "result"), "_meta"), MCP_SUBSCRIPTION_ID);

/** The params of a notification of a subscription, without `_meta`. */
const paramsOf = (message: Message): JsonObject => {
  const params = memberOf(message, "params");
  expect(isObject(params), `expected a notification with params, got ${JSON.stringify(message)}`);
  const { _meta: _, ...rest } = params;
  return rest;
};

/** How a server serves the events extension, as `checkEvents` tests it. */
export interface EventsOptions {
  /** The transport of the channel. Through stdio, the server never serves webhook delivery. */
  readonly transport: "http" | "stdio";
  /** The poll settings of the deployment. */
  readonly poll: PollSettings;
  /** `true` if conform tests webhook delivery through this server, so the server must serve it. */
  readonly webhook: boolean;
}

/** The order of the delivery modes in `events/list` (spec/bindings/mcp.md#events). */
const DELIVERY_ORDER = ["push", "poll", "webhook"];

/** The requests that the checks of events send through a channel, and the capabilities of the fixture that they call. */
export function eventRequests(channel: Channel) {
  const resultOf = async (method: string, params: JsonObject, signal: AbortSignal) => {
    const message = await channel.request(method, params, signal);
    const result = memberOf(message, "result");
    expect(isObject(result), `${method} must give a result, got ${JSON.stringify(message)}`);
    return result;
  };
  const errorOf = (message: Message | undefined) => {
    const error = memberOf(message, "error");
    expect(isObject(error), `expected a JSON-RPC error, got ${JSON.stringify(message)}`);
    return error;
  };
  const tool = async (name: string, args: JsonObject, signal: AbortSignal) => memberOf(await resultOf("tools/call", { name, arguments: args }, signal), "structuredContent");
  /** The keys of the subscriptions to `fixture.watch` that are active now. */
  const watching = async (signal: AbortSignal) => {
    const keys = memberOf(await tool("fixture.watching", {}, signal), "keys");
    expect(isStringArray(keys), `fixture.watching must give a list of keys, got ${JSON.stringify(keys)}`);
    return keys;
  };
  /** Give a value to the subscriptions to `fixture.watch` that watch the key. The result is the number of these subscriptions. */
  const signalKey = async (key: string, value: string, signal: AbortSignal) => memberOf(await tool("fixture.signal", { key, value }, signal), "delivered");
  return { resultOf, errorOf, tool, watching, signalKey };
}

/** The number of times that a key is in a list of keys. */
export const count = (keys: readonly string[], key: string) => keys.filter((each) => each === key).length;

/**
 * The checks of the events extension (spec/bindings/mcp.md#events), through a channel. Each transport runs them. Through
 * stdio, `cancel` sends `notifications/cancelled`; through HTTP, it closes the request.
 */
export async function checkEvents(checks: Checks, channel: Channel, options: EventsOptions): Promise<void> {
  const RULE_EVENTS = `${RULE}#events`;
  const { resultOf, errorOf, watching, signalKey } = eventRequests(channel);
  /** The next message of a stream, which must be a notification of the method for this subscription. */
  const notification = async (stream: EventStream, id: string, method: string) => {
    const message = await stream.next();
    expect(message !== undefined && message.method === method, `expected ${method}, got ${JSON.stringify(message)}`);
    expectEqual(subscriptionOf(message), id, `the subscription id of ${method}`);
    return message;
  };
  const occurrence = async (stream: EventStream, id: string, name: string) =>
    expectOccurrence(paramsOf(await notification(stream, id, "notifications/events/event")), name);
  const active = async (stream: EventStream, id: string) => {
    const message = await notification(stream, id, "notifications/events/active");
    expectEqual(paramsOf(message), { truncated: false }, "the params of notifications/events/active");
  };
  /** The response of the stream, which must be the result `complete` for this subscription, then the end. */
  const complete = async (stream: EventStream, id: string) => {
    const message = await stream.next();
    expect(message !== undefined && message.id === id, `expected the result of events/stream, got ${JSON.stringify(message)}`);
    expectEqual(memberOf(memberOf(message, "result"), "resultType"), "complete", "resultType");
    expectEqual(subscriptionOf(message), id, "the subscription id of the result");
    expectEqual(await stream.next(), undefined, "the stream after the result");
  };
  const streamId = () => `conform-${randomUUID()}`;

  await checks.run("server/discover declares the events extension", RULE_EVENTS, async (signal) => {
    const result = await resultOf("server/discover", {}, signal);
    const extensions = memberOf(memberOf(result, "capabilities"), "extensions");
    expect(isObject(memberOf(extensions, MCP_EVENTS_EXTENSION)), `the capabilities must have the extension ${MCP_EVENTS_EXTENSION}, got ${JSON.stringify(result)}`);
  });
  /** The delivery modes that the server serves, from `events/list`. */
  let delivery: readonly string[] = [];
  await checks.run("events/list gives each event of the view, with the delivery modes of the server and its schemas", RULE_EVENTS, async (signal) => {
    const result = await resultOf("events/list", {}, signal);
    const entries = result.events;
    if (!isArrayOf(entries, isObject)) throw new Error(`events/list must give a list of events, got ${JSON.stringify(result)}`);
    expectEqual(sorted(entries.map((entry) => String(entry.name))), eventIdsOf("mcp"), "names");
    const first = entries[0]?.delivery;
    expect(isStringArray(first), `the delivery of each event must be a list of modes, got ${JSON.stringify(first)}`);
    expectEqual(first, DELIVERY_ORDER.filter((mode) => first.includes(mode)), "the delivery modes, in the order push, poll, webhook, each once");
    expect(first.includes("push"), `the server must serve push delivery, got ${JSON.stringify(first)}`);
    if (options.transport === "stdio") expect(!first.includes("webhook"), "through stdio, the server must not serve webhook delivery");
    if (options.webhook) expect(first.includes("webhook"), `webhook delivery is on, so the delivery must have webhook, got ${JSON.stringify(first)}`);
    delivery = first;
    for (const entry of entries) {
      const name = String(entry.name);
      expectEqual(entry.description, fixture.events?.[name]?.description, `description of ${name}`);
      expectEqual(entry.delivery, first, `delivery of ${name}`);
      expectEqual(memberOf(entry.inputSchema, "type"), "object", `the type of the inputSchema of ${name}`);
      expectEqual(memberOf(entry.payloadSchema, "type"), "object", `the type of the payloadSchema of ${name}`);
    }
    expectEqual(result.resultType, "complete", "resultType");
    expect(!("nextCursor" in result), "the result must have no nextCursor");
  });
  for (const [name, params, code, kind] of [
    ["events/stream of an event outside the view is NotFound, with the kind event", { name: "fixture.secret", arguments: {} }, -32023, "event"],
    ["events/stream of the id of a capability is NotFound", { name: "fixture.echo", arguments: { text: "x" } }, -32023, "event"],
    ["events/stream with invalid input is the error -32602", { name: "fixture.ticks", arguments: { count: 101 } }, -32602, undefined],
  ] as const) {
    await checks.run(name, RULE_EVENTS, async (signal) => {
      const stream = await channel.stream(streamId(), params, signal);
      try {
        const error = errorOf(await stream.next());
        expectEqual(error.code, code, "the JSON-RPC error code");
        if (kind !== undefined) expectEqual(memberOf(error.data, "kind"), kind, "data.kind");
      } finally {
        await stream.cancel();
      }
    });
  }
  await checks.run("events/stream gives active, each occurrence in order, then the result", RULE_EVENTS, async (signal) => {
    const id = streamId();
    const stream = await channel.stream(id, { name: "fixture.ticks", arguments: { count: 3 } }, signal);
    try {
      await active(stream, id);
      for (const n of [1, 2, 3]) {
        const each = await occurrence(stream, id, "fixture.ticks");
        expectEqual(each.data, { n }, "data");
        expectEqual([each.eventId, each.cursor], [String(n), String(n)], "the eventId and the cursor");
      }
      await complete(stream, id);
    } finally {
      await stream.cancel();
    }
  });
  await checks.run("events/stream with a cursor starts after it", RULE_EVENTS, async (signal) => {
    const id = streamId();
    const stream = await channel.stream(id, { name: "fixture.ticks", arguments: { count: 3 }, cursor: "1" }, signal);
    try {
      await active(stream, id);
      for (const n of [2, 3]) expectEqual((await occurrence(stream, id, "fixture.ticks")).data, { n }, "data");
      await complete(stream, id);
    } finally {
      await stream.cancel();
    }
  });
  await checks.run("a defect after an occurrence sends notifications/events/terminated, then the result", RULE_EVENTS, async (signal) => {
    const id = streamId();
    const stream = await channel.stream(id, { name: "fixture.broken", arguments: {} }, signal);
    try {
      await active(stream, id);
      expectEqual((await occurrence(stream, id, "fixture.broken")).data, { n: 1 }, "data");
      const terminated = paramsOf(await notification(stream, id, "notifications/events/terminated"));
      expectEqual(memberOf(terminated.error, "code"), -32603, "the error code of notifications/events/terminated");
      expect(!/\n\s+at /.test(String(memberOf(terminated.error, "message"))), "the message must not contain a stack trace");
      await complete(stream, id);
    } finally {
      await stream.cancel();
    }
  });
  await checks.run("events/stream gets the things that happen, and cancelling it ends the subscription", RULE_EVENTS, async (signal) => {
    const key = randomUUID();
    const id = streamId();
    const stream = await channel.stream(id, { name: "fixture.watch", arguments: { key } }, signal);
    try {
      await active(stream, id);
      await until("fixture.watching gives the key", () => watching(signal), (keys) => keys.includes(key), signal);
      expectEqual(await signalKey(key, "first", signal), 1, "the subscriptions that fixture.signal reached");
      expectEqual((await occurrence(stream, id, "fixture.watch")).data, { key, value: "first" }, "data");
      await stream.cancel();
      await until("the key leaves fixture.watching", () => watching(signal), (keys) => !keys.includes(key), signal);
    } finally {
      await stream.cancel();
    }
  });
  await checks.run("two subscriptions at the same time each get their own messages, and cancelling one leaves the other", RULE_EVENTS, async (signal) => {
    const key = randomUUID();
    const [firstId, secondId] = [streamId(), streamId()];
    const first = await channel.stream(firstId, { name: "fixture.watch", arguments: { key } }, signal);
    const second = await channel.stream(secondId, { name: "fixture.watch", arguments: { key } }, signal);
    try {
      await active(first, firstId);
      await active(second, secondId);
      await until("fixture.watching gives the key of both subscriptions", () => watching(signal), (keys) => count(keys, key) === 2, signal);
      expectEqual(await signalKey(key, "both", signal), 2, "the subscriptions that fixture.signal reached");
      expectEqual((await occurrence(first, firstId, "fixture.watch")).data, { key, value: "both" }, "data of the first subscription");
      expectEqual((await occurrence(second, secondId, "fixture.watch")).data, { key, value: "both" }, "data of the second subscription");
      await first.cancel();
      await until("the cancelled subscription leaves fixture.watching", () => watching(signal), (keys) => count(keys, key) === 1, signal);
      expectEqual(await signalKey(key, "after", signal), 1, "the subscriptions that fixture.signal reached");
      expectEqual((await occurrence(second, secondId, "fixture.watch")).data, { key, value: "after" }, "data of the second subscription");
    } finally {
      await first.cancel();
      await second.cancel();
    }
  });
  if (delivery.includes("poll")) {
    await checkPoll(checks, channel, options.poll);
  } else {
    await checks.should("the server serves poll delivery", `${RULE}#events`, () => {
      throw new Error("events/list gives no poll delivery. A server that keeps no state between requests serves push only.");
    });
    await checks.run("events/poll is Unsupported, with the delivery mode poll", RULE_EVENTS, async (signal) => {
      const error = errorOf(await channel.request("events/poll", { name: "fixture.ticks", arguments: { count: 1 } }, signal));
      expectEqual(error.code, -32026, "the JSON-RPC error code");
      expectEqual(error.data, { feature: "deliveryMode", value: "poll" }, "data");
    });
  }
  if (!delivery.includes("webhook")) {
    await checks.run("events/subscribe and events/unsubscribe are Unsupported, with the delivery mode webhook", `${RULE}#webhook`, async (signal) => {
      const url = "https://webhook.acid-cat.invalid/hook";
      const subscribe = { name: "fixture.ticks", arguments: { count: 1 }, delivery: { mode: "webhook", url, secret: `whsec_${"A".repeat(32)}` } };
      for (const [method, params] of [["events/subscribe", subscribe], ["events/unsubscribe", { name: "fixture.ticks", arguments: { count: 1 }, delivery: { url } }]] as const) {
        const error = errorOf(await channel.request(method, params, signal));
        expectEqual(error.code, -32026, `the JSON-RPC error code of ${method}`);
        expectEqual(error.data, { feature: "deliveryMode", value: "webhook" }, `the data of ${method}`);
      }
    });
  }
}
