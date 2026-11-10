/**
 * Conformance checks for webhook delivery of the MCP events extension (spec/bindings/mcp.md#webhook), through HTTP.
 * conform runs an HTTPS receiver on 127.0.0.1 with the certificate that it gets. The deployment under test must trust
 * that certificate, allow deliveries to 127.0.0.1, and give the principal of `WebhookSettings` to each request with the
 * header `Authorization: Bearer <principal>`.
 *
 * Each check uses its own path on the receiver, so its URL is new: the server verifies it again, and the subscriptions
 * of one check, or of an earlier run of conform, never have the key of another check.
 */
import { randomBytes, randomUUID } from "node:crypto";
import type { IncomingHttpHeaders } from "node:http";
import { createServer } from "node:https";

import { isOccurrence, webhookSignature, webhookSubscriptionId } from "@acid-cat/spec-ts";

import { isObject, memberOf, parseJson } from "../json.ts";
import type { JsonObject } from "../json.ts";
import { Checks, expect, expectEqual, expectOccurrence, until } from "./check.ts";
import { count, eventRequests, httpChannel } from "./mcp.ts";
import type { Message } from "./mcp.ts";

const RULE = "spec/bindings/mcp.md#webhook";

/** The settings of the checks of webhook delivery. */
export interface WebhookSettings {
  /** The principal that the deployment gives to a request with the header `Authorization: Bearer <principal>`. */
  readonly principal: string;
  /** The certificate of the receiver, in PEM. It must be valid for the IP address 127.0.0.1. */
  readonly cert: string;
  /** The private key of the certificate, in PEM. */
  readonly key: string;
}

/** One request that the receiver got. */
interface Received {
  readonly headers: IncomingHttpHeaders;
  readonly text: string;
  readonly body: unknown;
}

/** The answer of the receiver to a request: a status, and a body. */
interface Answer {
  readonly status: number;
  readonly body?: string;
}

/** Chooses the answer to a request. `index` counts the requests of the path that are not verifications, from 0. */
type Answerer = (request: Received, index: number) => Answer | undefined;

/** True if the body of a request is the control message `verification`. */
const isVerification = (request: Received) => memberOf(request.body, "type") === "verification";

/**
 * Start the receiver. By default, it answers a verification with its challenge, and each other request with 200. A
 * check can choose other answers for its path.
 */
async function startReceiver(settings: WebhookSettings) {
  const received = new Map<string, Received[]>();
  const answerers = new Map<string, Answerer>();
  const server = createServer({ cert: settings.cert, key: settings.key }, (request, response) => {
    const chunks: Buffer[] = [];
    request.on("data", (chunk: Buffer) => chunks.push(chunk));
    request.on("end", () => {
      const path = request.url ?? "/";
      const text = Buffer.concat(chunks).toString("utf8");
      let body: unknown;
      try {
        body = parseJson(text);
      } catch {
        body = undefined;
      }
      const each: Received = { headers: request.headers, text, body };
      const list = received.get(path) ?? [];
      list.push(each);
      received.set(path, list);
      const index = list.filter((one) => !isVerification(one)).length - 1;
      const verification = { status: 200, body: JSON.stringify({ challenge: memberOf(body, "challenge") }) };
      const chosen = answerers.get(path)?.(each, index) ?? (isVerification(each) ? verification : { status: 200 });
      response.writeHead(chosen.status, { "Content-Type": "application/json" }).end(chosen.body ?? "");
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address = server.address();
  const port = typeof address === "object" && address !== null ? address.port : 0;
  return {
    /** A new URL on the receiver, for one check. */
    url: (answer?: Answerer) => {
      const path = `/hook/${randomUUID()}`;
      if (answer !== undefined) answerers.set(path, answer);
      return { url: `https://127.0.0.1:${port}${path}`, received: () => received.get(path) ?? [] };
    },
    close: () =>
      new Promise<void>((resolve) => {
        server.closeAllConnections();
        server.close(() => resolve());
      }),
  };
}

/** A new Standard Webhooks secret. */
const newSecret = () => `whsec_${randomBytes(32).toString("base64")}`;

/** One header of a request, as text. */
function header(request: Received, name: string): string {
  const value = request.headers[name];
  expect(typeof value === "string", `the request must have the header ${name}, got ${JSON.stringify(request.headers)}`);
  return value;
}

/**
 * Check the headers of a request of the server: the media type, the id, the timestamp, the subscription id, and a
 * signature with each secret. `type` is the type of a control message; with none, the request is an occurrence.
 */
async function expectSigned(request: Received, subscription: string, secrets: readonly string[], type?: string): Promise<string> {
  expect(header(request, "content-type").startsWith("application/json"), `Content-Type must be application/json, got ${header(request, "content-type")}`);
  const id = header(request, "webhook-id");
  const pattern = type === undefined ? /^msg_[A-Za-z0-9]+$/ : new RegExp(`^msg_${type}_[A-Za-z0-9]+$`);
  expect(pattern.test(id), `webhook-id must match ${pattern}, got ${JSON.stringify(id)}`);
  const timestampText = header(request, "webhook-timestamp");
  const timestamp = Number(timestampText);
  expect(/^\d+$/.test(timestampText) && Math.abs(timestamp - Date.now() / 1000) <= 300, `webhook-timestamp must be the time in seconds, got ${JSON.stringify(timestampText)}`);
  expectEqual(header(request, "x-mcp-subscription-id"), subscription, "X-MCP-Subscription-Id");
  const signatures = header(request, "webhook-signature").split(" ");
  for (const secret of secrets) {
    const expected = await webhookSignature([secret], id, timestamp, request.text);
    expect(signatures.includes(expected), `webhook-signature must have the signature ${expected} of a secret, got ${JSON.stringify(signatures)}`);
  }
  return id;
}

/** The body of a delivery of an occurrence: the occurrence without `truncated`. */
function expectDelivered(request: Received, name: string) {
  expect(isObject(request.body) && !("truncated" in request.body), `the body must be an occurrence without truncated, got ${request.text}`);
  return expectOccurrence(request.body, name);
}

/** The checks of webhook delivery through the MCP server at `url`. */
export async function checkWebhook(checks: Checks, url: string, settings: WebhookSettings): Promise<void> {
  let receiver: Awaited<ReturnType<typeof startReceiver>>;
  try {
    receiver = await startReceiver(settings);
  } catch (error) {
    await checks.run("conform starts an HTTPS receiver with the certificate and the key", RULE, () => {
      throw error instanceof Error ? error : new Error(String(error));
    });
    return;
  }
  try {
    await checkWithReceiver(checks, url, settings, receiver);
  } finally {
    await receiver.close();
  }
}

async function checkWithReceiver(checks: Checks, url: string, settings: WebhookSettings, receiver: Awaited<ReturnType<typeof startReceiver>>): Promise<void> {
  const principal = settings.principal;
  const channel = httpChannel(url, { Authorization: `Bearer ${principal}` });
  const anonymous = httpChannel(url);
  const { errorOf, watching, signalKey } = eventRequests(channel);
  const subscribeParams = (name: string, input: JsonObject, hook: string, secret: string, extra: JsonObject = {}) => ({ name, arguments: input, delivery: { mode: "webhook", url: hook, secret }, ...extra });
  const unsubscribeParams = (name: string, input: JsonObject, hook: string) => ({ name, arguments: input, delivery: { url: hook } });
  const resultOf = (message: Message, method: string) => {
    const result = memberOf(message, "result");
    expect(isObject(result), `${method} must give a result, got ${JSON.stringify(message)}`);
    return result;
  };
  /** Subscribe, and check the form of the result (spec/bindings/mcp.md#webhook). */
  const subscribe = async (name: string, input: JsonObject, hook: string, secret: string, signal: AbortSignal, extra: JsonObject = {}) => {
    const result = resultOf(await channel.request("events/subscribe", subscribeParams(name, input, hook, secret, extra), signal), "events/subscribe");
    expectEqual(result.resultType, "complete", "resultType");
    expectEqual(result.id, await webhookSubscriptionId(principal, hook, name, input), "the subscription id");
    const refreshBefore = result.refreshBefore;
    expect(typeof refreshBefore === "string" && /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?(Z|[+-]\d{2}:\d{2})$/.test(refreshBefore), `refreshBefore must be an RFC 3339 date and time, got ${JSON.stringify(refreshBefore)}`);
    expect(Date.parse(refreshBefore) > Date.now(), `refreshBefore must be in the future, got ${refreshBefore}`);
    expect(result.cursor === null || typeof result.cursor === "string", `cursor must be the watermark or null, got ${JSON.stringify(result.cursor)}`);
    expectEqual(result.truncated, false, "truncated");
    const status = result.deliveryStatus;
    expectEqual(memberOf(status, "active"), true, "deliveryStatus.active");
    const last = memberOf(status, "lastDeliveryAt");
    expect(last === null || typeof last === "string", `deliveryStatus.lastDeliveryAt must be a date or null, got ${JSON.stringify(last)}`);
    expect(isObject(status) && "lastError" in status, `deliveryStatus must have lastError, got ${JSON.stringify(status)}`);
    return { id: String(result.id), refreshBefore: Date.parse(refreshBefore) };
  };
  const unsubscribe = (name: string, input: JsonObject, hook: string, signal: AbortSignal) => channel.request("events/unsubscribe", unsubscribeParams(name, input, hook), signal);
  /** End a subscription at the end of a check. It can be gone already. */
  const cleanup = (name: string, input: JsonObject, hook: string) => unsubscribe(name, input, hook, AbortSignal.timeout(checks.deadline)).catch(() => undefined);
  /** The requests of a URL that are not verifications. */
  const deliveries = (hook: { readonly received: () => readonly Received[] }) => hook.received().filter((each) => !isVerification(each));
  const atLeast = (hook: { readonly received: () => readonly Received[] }, number: number, signal: AbortSignal) =>
    until(`the receiver gets ${number} deliveries`, async () => deliveries(hook), (list) => list.length >= number, signal);
  const watchedKey = (key: string) => (keys: readonly string[]) => keys.includes(key);

  await checks.run("events/subscribe and events/unsubscribe with no principal are Forbidden", RULE, async (signal) => {
    const hook = receiver.url();
    const input = { key: randomUUID() };
    const subscribed = errorOf(await anonymous.request("events/subscribe", subscribeParams("fixture.watch", input, hook.url, newSecret()), signal));
    expectEqual(subscribed.code, -32024, "the JSON-RPC error code of events/subscribe");
    const unsubscribed = errorOf(await anonymous.request("events/unsubscribe", unsubscribeParams("fixture.watch", input, hook.url), signal));
    expectEqual(unsubscribed.code, -32024, "the JSON-RPC error code of events/unsubscribe");
    expectEqual(hook.received().length, 0, "the requests that the receiver got");
  });

  await checks.run("a URL that is not https, or a secret that is not valid, is the error -32602", RULE, async (signal) => {
    const hook = receiver.url();
    const http = hook.url.replace(/^https:/, "http:");
    for (const [what, params] of [
      ["a URL that is not https", subscribeParams("fixture.watch", { key: randomUUID() }, http, newSecret())],
      ["a secret of 16 bytes", subscribeParams("fixture.watch", { key: randomUUID() }, hook.url, `whsec_${randomBytes(16).toString("base64")}`)],
      ["a secret with no prefix", subscribeParams("fixture.watch", { key: randomUUID() }, hook.url, randomBytes(32).toString("base64"))],
    ] as const) {
      expectEqual(errorOf(await channel.request("events/subscribe", params, signal)).code, -32602, `the JSON-RPC error code for ${what}`);
    }
    expectEqual(hook.received().length, 0, "the requests that the receiver got");
  });

  await checks.run("the server verifies a new URL with a challenge, then answers with the subscription", RULE, async (signal) => {
    const hook = receiver.url();
    const input = { count: 0, key: randomUUID() };
    const secret = newSecret();
    try {
      const { id } = await subscribe("fixture.ticks", input, hook.url, secret, signal);
      const [verification] = hook.received();
      expect(verification !== undefined && isVerification(verification), `the first request must be the verification, got ${JSON.stringify(verification?.body)}`);
      expect(typeof memberOf(verification.body, "challenge") === "string", `the verification must have a challenge, got ${verification.text}`);
      await expectSigned(verification, id, [secret], "verification");
    } finally {
      await cleanup("fixture.ticks", input, hook.url);
    }
  });

  await checks.run("an endpoint that does not answer the challenge is CallbackEndpointError, and the subscription does not start", RULE, async (signal) => {
    const hook = receiver.url((request) => (isVerification(request) ? { status: 200, body: JSON.stringify({ challenge: "wrong" }) } : undefined));
    const input = { key: randomUUID() };
    const error = errorOf(await channel.request("events/subscribe", subscribeParams("fixture.watch", input, hook.url, newSecret()), signal));
    expectEqual(error.code, -32027, "the JSON-RPC error code");
    expectEqual(memberOf(error.data, "reason"), "challenge_failed", "data.reason");
    await until("the key is not in fixture.watching", () => watching(signal), (keys) => !keys.includes(input.key), signal);
    expectEqual(hook.received().length, 1, "the requests that the receiver got: only the verification");
  });

  await checks.run("each occurrence is one signed POST, in order, whose cursor is the watermark", RULE, async (signal) => {
    const hook = receiver.url();
    const input = { count: 3, key: randomUUID() };
    const secret = newSecret();
    try {
      const { id } = await subscribe("fixture.ticks", input, hook.url, secret, signal);
      const list = await atLeast(hook, 3, signal);
      const ids = new Set<string>();
      for (const [index, request] of list.entries()) {
        const n = index + 1;
        ids.add(await expectSigned(request, id, [secret]));
        const occurrence = expectDelivered(request, "fixture.ticks");
        expectEqual([occurrence.data, occurrence.eventId, occurrence.cursor], [{ n }, String(n), String(n)], "the data, the eventId and the cursor");
      }
      expectEqual(ids.size, 3, "the number of different webhook-id headers");
    } finally {
      await cleanup("fixture.ticks", input, hook.url);
    }
  });

  await checks.run("a subscription gets the things that happen; a renewal grants a new lifetime and signs with both secrets; events/unsubscribe ends it", RULE, async (signal) => {
    const hook = receiver.url();
    const input = { key: randomUUID() };
    const [first, second] = [newSecret(), newSecret()];
    try {
      const started = await subscribe("fixture.watch", input, hook.url, first, signal, { ttlMs: 60_000 });
      await until("fixture.watching gives the key", () => watching(signal), watchedKey(input.key), signal);
      expectEqual(await signalKey(input.key, "a", signal), 1, "the subscriptions that fixture.signal reached");
      const [a] = await atLeast(hook, 1, signal);
      if (a === undefined) throw new Error("the receiver got no delivery");
      await expectSigned(a, started.id, [first]);
      const occurrence = expectDelivered(a, "fixture.watch");
      expectEqual(occurrence.data, { ...input, value: "a" }, "the data");
      expect(!("cursor" in occurrence), `with no cursor of the provider, the delivery has no cursor, got ${a.text}`);

      const renewed = await subscribe("fixture.watch", input, hook.url, second, signal);
      expectEqual(renewed.id, started.id, "the subscription id of the renewal");
      expect(renewed.refreshBefore >= started.refreshBefore, "the renewal must not grant a shorter lifetime than the first grant of 60 000 ms");
      expectEqual(count(await watching(signal), input.key), 1, "the subscriptions of the key after the renewal");
      expectEqual(await signalKey(input.key, "b", signal), 1, "the subscriptions that fixture.signal reached after the renewal");
      const [, b] = await atLeast(hook, 2, signal);
      if (b === undefined) throw new Error("the receiver got no second delivery");
      await expectSigned(b, started.id, [second, first]);

      expectEqual(memberOf(resultOf(await unsubscribe("fixture.watch", input, hook.url, signal), "events/unsubscribe"), "resultType"), "complete", "the resultType of events/unsubscribe");
      await until("the key leaves fixture.watching", () => watching(signal), (keys) => !keys.includes(input.key), signal);
      const again = errorOf(await unsubscribe("fixture.watch", input, hook.url, signal));
      expectEqual(again.code, -32023, "the JSON-RPC error code of a second events/unsubscribe");
      expectEqual(memberOf(again.data, "kind"), "subscription", "data.kind");
    } finally {
      await cleanup("fixture.watch", input, hook.url);
    }
  });

  await checks.run("a delivery that gets a status that is not 2xx is sent again, with the same webhook-id", RULE, async (signal) => {
    const hook = receiver.url((request, index) => (!isVerification(request) && index === 0 ? { status: 500 } : undefined));
    const input = { key: randomUUID() };
    const secret = newSecret();
    try {
      const { id } = await subscribe("fixture.watch", input, hook.url, secret, signal);
      await until("fixture.watching gives the key", () => watching(signal), watchedKey(input.key), signal);
      await signalKey(input.key, "again", signal);
      const [failed, retried] = await atLeast(hook, 2, signal);
      if (failed === undefined || retried === undefined) throw new Error("the receiver got no retry");
      const firstId = await expectSigned(failed, id, [secret]);
      expectEqual(await expectSigned(retried, id, [secret]), firstId, "the webhook-id of the second attempt");
      expectEqual(retried.text, failed.text, "the body of the second attempt");
    } finally {
      await cleanup("fixture.watch", input, hook.url);
    }
  });

  await checks.run("a 410 abandons the delivery at once, and the next occurrence follows", RULE, async (signal) => {
    const hook = receiver.url((request, index) => (!isVerification(request) && index === 0 ? { status: 410 } : undefined));
    const input = { key: randomUUID() };
    try {
      await subscribe("fixture.watch", input, hook.url, newSecret(), signal);
      await until("fixture.watching gives the key", () => watching(signal), watchedKey(input.key), signal);
      await signalKey(input.key, "gone", signal);
      await atLeast(hook, 1, signal);
      await signalKey(input.key, "next", signal);
      const [gone, next] = await atLeast(hook, 2, signal);
      if (gone === undefined || next === undefined) throw new Error("the receiver got no second delivery");
      expectEqual(expectDelivered(gone, "fixture.watch").data, { ...input, value: "gone" }, "the data of the first delivery");
      expectEqual(expectDelivered(next, "fixture.watch").data, { ...input, value: "next" }, "the data of the second delivery");
    } finally {
      await cleanup("fixture.watch", input, hook.url);
    }
  });

  await checks.run("a defect after an occurrence sends the control message terminated", RULE, async (signal) => {
    const hook = receiver.url();
    const secret = newSecret();
    try {
      const { id } = await subscribe("fixture.broken", {}, hook.url, secret, signal);
      const [occurrence, terminated] = await atLeast(hook, 2, signal);
      if (occurrence === undefined || terminated === undefined) throw new Error("the receiver got no control message");
      expectEqual(expectDelivered(occurrence, "fixture.broken").data, { n: 1 }, "the data of the occurrence");
      expect(!isOccurrence(terminated.body), `the second request must be a control message, got ${terminated.text}`);
      expectEqual(memberOf(terminated.body, "type"), "terminated", "the type of the control message");
      const error = memberOf(terminated.body, "error");
      expectEqual(memberOf(error, "code"), -32603, "the error code of the control message");
      expect(typeof memberOf(error, "message") === "string" && !/\n\s+at /.test(String(memberOf(error, "message"))), "the message must be text with no stack trace");
      await expectSigned(terminated, id, [secret], "terminated");
    } finally {
      await cleanup("fixture.broken", {}, hook.url);
    }
  });
}
