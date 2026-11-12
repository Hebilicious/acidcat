/**
 * Webhook delivery through MCP (spec/bindings/mcp.md#webhook), on Node.js. The server sends the occurrences of each
 * webhook subscription in HTTP `POST` requests to a URL of the client, signed as Standard Webhooks specifies.
 *
 * This module uses `node:https`, `node:dns` and `node:crypto`. `@acid-cat/core-ts/node` exports it.
 */
import { randomBytes, timingSafeEqual } from "node:crypto";
import { lookup as dnsLookup } from "node:dns";
import type { LookupAddress } from "node:dns";
import { request as httpsRequest } from "node:https";
import { isIP } from "node:net";
import { rootCertificates } from "node:tls";

import {
  canonicalJson,
  isGloballyRoutable,
  isJsonObject,
  MCP_EVENT_ERRORS,
  MCP_WEBHOOK_DEFAULTS,
  mcpSubscribeError,
  webhookGrantMs,
  webhookSecretBytes,
  webhookSignature,
  webhookSubscriptionId,
} from "@acid-cat/spec-ts";
import type { JsonObject, Occurrence, WebhookError } from "@acid-cat/spec-ts";

import { sleep, systemClock } from "./clock.ts";
import type { Clock } from "./clock.ts";
import { endMessage, invalidParams, subscriptionParams } from "./mcp-events.ts";
import type { JsonRpcError, OpenSession, OwnSession, RpcAnswer, WebhookDelivery } from "./mcp-events.ts";
import { isMaxAgeMs } from "./session.ts";
import type { Occurrences } from "./subscription.ts";

/** The settings of webhook delivery. Each limit has the default of spec/bindings/mcp.md#webhook. */
export interface WebhookOptions {
  /**
   * The allowlist: a URL for which this function gives `true` gets deliveries with no verification. With no function,
   * each pair of principal and URL needs a verification.
   */
  readonly allow?: ((url: URL) => boolean) | undefined;
  /**
   * Connect also to addresses that are not globally routable, for example `127.0.0.1` or `10.0.0.1`. Only for tests and
   * private deployments. The default is `false`.
   */
  readonly allowPrivateNetworks?: boolean | undefined;
  /** Certificates of authorities to trust beside the default ones, in PEM form. For example the authority of a test receiver. */
  readonly ca?: string | Buffer | readonly (string | Buffer)[] | undefined;
  /** The maximum lifetime of a subscription, in milliseconds. The default is 1 hour. */
  readonly maxTtlMs?: number | undefined;
  /** The minimum lifetime of a subscription, in milliseconds. The default is 1 minute. */
  readonly minTtlMs?: number | undefined;
  /** The maximum number of webhook subscriptions of one principal. The default is 100. */
  readonly maxSubscriptions?: number | undefined;
  /** The maximum number of attempts to send one delivery. The default is 5. */
  readonly attempts?: number | undefined;
  /** The time in which the server makes the attempts of one delivery, in milliseconds. The default is 15 minutes. */
  readonly retryWindowMs?: number | undefined;
  /** The time that the server waits for each answer, in milliseconds. The default is 5 seconds. */
  readonly timeoutMs?: number | undefined;
  /** The time after a change of the secret in which the server signs with the old secret and the new secret. The default is 5 minutes. */
  readonly rotationGraceMs?: number | undefined;
  /**
   * The wait before the next attempt, after attempt number `attempt` (1 for the first attempt) failed, in milliseconds.
   * The default is 10 seconds, multiplied by 3 for each attempt: 10 s, 30 s, 90 s and 270 s.
   */
  readonly retryDelayMs?: ((attempt: number) => number) | undefined;
  /** The clock of lifetimes and retries. The default is the clock of the system. */
  readonly clock?: Clock | undefined;
}

/** The answer of an endpoint: its status and its text, or the category of the failure. */
type Posted = { readonly status: number; readonly text: string } | { readonly failure: WebhookError };

interface Subscription {
  readonly id: string;
  readonly key: string;
  readonly principal: string;
  readonly url: URL;
  readonly own: OwnSession;
  readonly occurrences: Occurrences<unknown>;
  /** Aborts when the subscription ends. It stops the waits between attempts. */
  readonly ended: AbortController;
  secret: string;
  /** The secret before the last change, and the time until which the server still signs with it. */
  previous: { readonly secret: string; readonly until: number } | undefined;
  expiresAt: number;
  cancelExpiry: () => void;
  watermark: string | null;
  lastDeliveryAt: string | null;
  lastError: WebhookError | null;
}

/** Make webhook delivery for `mcpHandler` (option `webhooks`). */
export function webhookDelivery(options: WebhookOptions = {}): WebhookDelivery {
  const settings = {
    maxTtlMs: options.maxTtlMs ?? MCP_WEBHOOK_DEFAULTS.maxTtlMs,
    minTtlMs: options.minTtlMs ?? MCP_WEBHOOK_DEFAULTS.minTtlMs,
    maxSubscriptions: options.maxSubscriptions ?? MCP_WEBHOOK_DEFAULTS.maxSubscriptions,
    attempts: options.attempts ?? MCP_WEBHOOK_DEFAULTS.attempts,
    retryWindowMs: options.retryWindowMs ?? MCP_WEBHOOK_DEFAULTS.retryWindowMs,
    timeoutMs: options.timeoutMs ?? MCP_WEBHOOK_DEFAULTS.timeoutMs,
    rotationGraceMs: options.rotationGraceMs ?? MCP_WEBHOOK_DEFAULTS.rotationGraceMs,
    retryDelayMs: options.retryDelayMs ?? ((attempt: number) => 10_000 * 3 ** (attempt - 1)),
  };
  const clock = options.clock ?? systemClock;
  const network: Network = {
    allowPrivateNetworks: options.allowPrivateNetworks === true,
    ca: options.ca === undefined ? undefined : [...rootCertificates, ...(typeof options.ca === "string" || Buffer.isBuffer(options.ca) ? [options.ca] : options.ca)],
    timeoutMs: settings.timeoutMs,
  };
  const subscriptions = new Map<string, Subscription>();
  /** The subscriptions that start, by key. A second request with the same key waits for the first. */
  const starting = new Map<string, Promise<unknown>>();
  /** The pairs of principal and URL that agreed to get deliveries, while the process runs. */
  const verified = new Set<string>();
  const pumps = new Set<Promise<void>>();
  let closed = false;

  /** The headers of a delivery, with a new timestamp and signature. */
  async function headersOf(subscription: { readonly id: string; readonly secrets: readonly string[] }, webhookId: string, body: string): Promise<Record<string, string>> {
    const timestamp = Math.floor(clock.now() / 1000);
    return {
      "Content-Type": "application/json",
      "webhook-id": webhookId,
      "webhook-timestamp": String(timestamp),
      "webhook-signature": await webhookSignature(subscription.secrets, webhookId, timestamp, body),
      "X-MCP-Subscription-Id": subscription.id,
    };
  }

  /** The secrets that sign a delivery now: the new secret, and the old secret during the grace time. */
  const secretsOf = (subscription: Subscription): string[] =>
    subscription.previous !== undefined && clock.now() < subscription.previous.until ? [subscription.secret, subscription.previous.secret] : [subscription.secret];

  /**
   * Send one delivery, with retries. The result is `delivered`, `abandoned`, or `stopped` when the subscription ended
   * before the end of the attempts.
   */
  async function deliver(subscription: Subscription, webhookId: string, body: string): Promise<"delivered" | "abandoned" | "stopped"> {
    const start = clock.now();
    for (let attempt = 1; ; attempt += 1) {
      if (subscription.ended.signal.aborted) return "stopped";
      const posted = await post(subscription.url, await headersOf({ id: subscription.id, secrets: secretsOf(subscription) }, webhookId, body), body, network);
      if ("status" in posted && posted.status >= 200 && posted.status < 300) {
        subscription.lastDeliveryAt = new Date(clock.now()).toISOString();
        subscription.lastError = null;
        return "delivered";
      }
      subscription.lastError = "failure" in posted ? posted.failure : statusError(posted.status);
      if ("status" in posted && (posted.status === 410 || posted.status === 413)) return "abandoned";
      const delay = settings.retryDelayMs(attempt);
      if (attempt >= settings.attempts || clock.now() - start + delay > settings.retryWindowMs) return "abandoned";
      if (!(await sleep(clock, delay, subscription.ended.signal))) return "stopped";
    }
  }

  /** Send the occurrences of a subscription one at a time, in order, until the subscription ends. */
  async function pump(subscription: Subscription): Promise<void> {
    for (;;) {
      let step: IteratorResult<Occurrence<unknown>, undefined>;
      try {
        step = await subscription.occurrences.next();
      } catch (error) {
        if (subscription.ended.signal.aborted) return;
        const body = JSON.stringify({ type: "terminated", error: { code: MCP_EVENT_ERRORS.internal, message: endMessage(error) } });
        await deliver(subscription, webhookIdOf("terminated"), body);
        return end(subscription);
      }
      // Complete, or cancelled: the subscription ends with no message.
      if (step.done === true) return end(subscription);
      const { truncated, cursor: own, ...rest } = step.value;
      if (truncated === true) {
        const sent = await deliver(subscription, webhookIdOf("gap"), JSON.stringify({ type: "gap", cursor: subscription.watermark }));
        if (sent === "stopped") return;
      }
      const cursor = own ?? subscription.watermark;
      const sent = await deliver(subscription, webhookIdOf(), JSON.stringify(cursor === null ? rest : { ...rest, cursor }));
      if (sent === "stopped") return;
      subscription.watermark = cursor;
    }
  }

  /** End a subscription: cancel it, close its session, and forget it. */
  async function end(subscription: Subscription): Promise<void> {
    if (subscription.ended.signal.aborted) return;
    subscription.ended.abort();
    subscription.cancelExpiry();
    if (subscriptions.get(subscription.key) === subscription) subscriptions.delete(subscription.key);
    await subscription.occurrences.return();
    await subscription.own.close();
  }

  /** Grant a lifetime. When it ends with no renewal, the subscription is cancelled. */
  function grant(subscription: Subscription, ttlMs: number | null | undefined): void {
    const lifetime = webhookGrantMs(ttlMs, settings);
    subscription.expiresAt = clock.now() + lifetime;
    subscription.cancelExpiry();
    subscription.cancelExpiry = clock.schedule(() => void end(subscription), lifetime);
  }

  /** Verify that the endpoint agrees to get deliveries for this principal. The result is the reason of a failure. */
  async function verify(principal: string, url: URL, id: string, secret: string): Promise<WebhookError | undefined> {
    const pair = canonicalJson([principal, url.href]);
    if (verified.has(pair) || options.allow?.(url) === true) return undefined;
    const challenge = randomBytes(24).toString("base64url");
    const body = JSON.stringify({ type: "verification", challenge });
    const posted = await post(url, await headersOf({ id, secrets: [secret] }, webhookIdOf("verification"), body), body, network);
    if ("failure" in posted) return posted.failure;
    // A 3xx status is http_4xx for a delivery, but challenge_failed for a verification (spec/bindings/mcp.md#webhook).
    if (posted.status >= 300 && posted.status < 400) return "challenge_failed";
    if (posted.status < 200 || posted.status >= 300) return statusError(posted.status);
    if (!sameText(challengeOf(posted.text), challenge)) return "challenge_failed";
    verified.add(pair);
    return undefined;
  }

  const resultOf = (subscription: Subscription): RpcAnswer => ({
    result: {
      id: subscription.id,
      refreshBefore: new Date(subscription.expiresAt).toISOString(),
      cursor: subscription.watermark,
      truncated: false,
      deliveryStatus: { active: true, lastDeliveryAt: subscription.lastDeliveryAt, lastError: subscription.lastError },
    },
  });

  /** Start a new subscription: subscribe in a session of its own, verify the endpoint, then send the occurrences. */
  async function start(principal: string, key: string, url: URL, secret: string, request: WebhookRequest, open: OpenSession): Promise<RpcAnswer> {
    const count = [...subscriptions.values()].filter((each) => each.principal === principal).length;
    if (count >= settings.maxSubscriptions) {
      return { error: { code: MCP_EVENT_ERRORS.resourceExhausted, message: "Too many webhook subscriptions.", data: { limit: "subscriptions", max: settings.maxSubscriptions } } };
    }
    const id = await webhookSubscriptionId(principal, request.rawUrl, request.name, request.input);
    const own = await open();
    const subscribed = await own.session.subscribe(request.name, request.input, {
      ...(request.cursor === undefined ? {} : { cursor: request.cursor }),
      ...(request.maxAgeMs === undefined ? {} : { maxAgeMs: request.maxAgeMs }),
    });
    if ("kind" in subscribed) {
      await own.close();
      return { error: mcpSubscribeError(subscribed) };
    }
    const reason = closed ? "connection_refused" : await verify(principal, url, id, secret);
    if (reason !== undefined || closed) {
      await subscribed.return();
      await own.close();
      return { error: callbackError(reason ?? "connection_refused") };
    }
    const subscription: Subscription = {
      id,
      key,
      principal,
      url,
      own,
      occurrences: subscribed,
      ended: new AbortController(),
      secret,
      previous: undefined,
      expiresAt: 0,
      cancelExpiry: () => {},
      watermark: null,
      lastDeliveryAt: null,
      lastError: null,
    };
    subscriptions.set(key, subscription);
    grant(subscription, request.ttlMs);
    const work = pump(subscription).finally(() => pumps.delete(work));
    pumps.add(work);
    return resultOf(subscription);
  }

  return {
    async subscribe(principal, params, open) {
      const read = readSubscribe(params);
      if ("error" in read) return read;
      const { url, secret } = read;
      // The key has the URL as the client sent it, not the parsed URL (spec/bindings/mcp.md#webhook).
      const key = subscriptionKey(principal, read.rawUrl, read.name, read.input);
      await starting.get(key);
      const existing = subscriptions.get(key);
      if (existing !== undefined) {
        // A subscription with this key exists, so the event exists: an invalid maxAgeMs is the next failure that applies.
        if (!isMaxAgeMs(read.maxAgeMs)) return invalidParams("maxAgeMs must be an integer that is 0 or more.");
        // Renew: a new lifetime and the new secret. The cursor of the request changes nothing.
        if (existing.secret !== secret) {
          existing.previous = { secret: existing.secret, until: clock.now() + settings.rotationGraceMs };
          existing.secret = secret;
        }
        grant(existing, read.ttlMs);
        return resultOf(existing);
      }
      const started = start(principal, key, url, secret, read, open);
      starting.set(key, started);
      return started.finally(() => starting.delete(key));
    },

    unsubscribe(principal, params) {
      const { name, arguments: input = {}, delivery } = params;
      const url = isJsonObject(delivery) ? delivery["url"] : undefined;
      if (typeof name !== "string" || typeof url !== "string") return Promise.resolve(invalidParams("events/unsubscribe needs name and delivery.url."));
      const subscription = subscriptions.get(subscriptionKey(principal, url, name, input));
      if (subscription === undefined) return Promise.resolve({ error: { code: MCP_EVENT_ERRORS.notFound, message: "There is no such subscription.", data: { kind: "subscription" } } });
      return end(subscription).then(() => ({ result: {} }));
    },

    async close() {
      closed = true;
      await Promise.allSettled(starting.values());
      await Promise.allSettled([...subscriptions.values()].map(end));
      await Promise.allSettled(pumps);
    },
  };
}

/** The parameters of `events/subscribe`, checked. */
interface WebhookRequest {
  readonly name: string;
  readonly input: unknown;
  readonly cursor: string | undefined;
  readonly maxAgeMs: number | undefined;
  readonly ttlMs: number | null | undefined;
  /** The URL to post to and to verify. */
  readonly url: URL;
  /** `delivery.url` as the client sent it. The subscription key and the subscription id use it. */
  readonly rawUrl: string;
  readonly secret: string;
}

/** The key of a webhook subscription: the principal, `delivery.url` as the client sent it, the id, and the input. */
const subscriptionKey = (principal: string, rawUrl: string, name: string, input: unknown): string => canonicalJson([principal, rawUrl, name, input]);

/** Read and check the parameters of `events/subscribe`. */
function readSubscribe(params: JsonObject): WebhookRequest | { readonly error: JsonRpcError } {
  const read = subscriptionParams(params);
  if ("error" in read) return read;
  const { delivery, ttlMs } = params;
  if (!isJsonObject(delivery) || delivery["mode"] !== "webhook") return invalidParams("delivery must be { mode: \"webhook\", url, secret }.");
  const { url, secret } = delivery;
  if (typeof url !== "string" || !URL.canParse(url) || new URL(url).protocol !== "https:") return invalidParams("delivery.url must be an https URL.");
  if (typeof secret !== "string" || webhookSecretBytes(secret) === undefined) return invalidParams("delivery.secret must be whsec_ and the base64 of 24 to 64 bytes.");
  if (ttlMs !== undefined && ttlMs !== null && (typeof ttlMs !== "number" || !Number.isFinite(ttlMs) || ttlMs < 0)) return invalidParams("ttlMs must be a number of milliseconds or null.");
  return { ...read, ttlMs, url: new URL(url), rawUrl: url, secret };
}

/** The error `CallbackEndpointError`. */
const callbackError = (reason: WebhookError): JsonRpcError => ({ code: MCP_EVENT_ERRORS.callbackEndpoint, message: "The callback endpoint did not agree to get deliveries.", data: { reason } });

/** The category of a status that is not `2xx`. */
const statusError = (status: number): WebhookError => (status >= 500 ? "http_5xx" : "http_4xx");

const ALPHANUMERIC = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** A new `webhook-id`: `msg_` and random letters and digits, or `msg_<type>_` and random letters and digits for a control message. */
function webhookIdOf(type?: string): string {
  // 248 is the largest multiple of 62 below 256, so that each character is equally likely.
  const characters = [...randomBytes(48)].filter((byte) => byte < 248).slice(0, 24).map((byte) => ALPHANUMERIC.charAt(byte % 62));
  return `msg_${type === undefined ? "" : `${type}_`}${characters.join("")}`;
}

/** The `challenge` of the JSON answer to a verification, or `undefined`. */
function challengeOf(text: string): string | undefined {
  try {
    const value: unknown = JSON.parse(text);
    return isJsonObject(value) && typeof value["challenge"] === "string" ? value["challenge"] : undefined;
  } catch {
    return undefined;
  }
}

/** Compare two texts in constant time. */
function sameText(received: string | undefined, expected: string): boolean {
  if (received === undefined) return false;
  const a = Buffer.from(received);
  const b = Buffer.from(expected);
  return a.length === b.length && timingSafeEqual(a, b);
}

// --- The network --------------------------------------------------------------------------------------------------

interface Network {
  readonly allowPrivateNetworks: boolean;
  readonly ca: readonly (string | Buffer)[] | undefined;
  readonly timeoutMs: number;
}

/** The largest answer that the server reads, in bytes. The server reads only the answer to a verification. */
const MAXIMUM_ANSWER_BYTES = 65_536;

/** An error of the lookup: the host name has no address that the server can connect to. */
class BlockedAddressError extends Error {
  readonly code = "EBLOCKEDADDRESS";
}

/**
 * Send one `POST` request. The server resolves the host name, and connects only to an address that it accepts. It
 * connects to that address, with the host name in the `Host` header and in TLS. It does not follow redirects.
 */
function post(url: URL, headers: Record<string, string>, body: string, network: Network): Promise<Posted> {
  const host = url.hostname.startsWith("[") ? url.hostname.slice(1, -1) : url.hostname;
  const accepts = (address: string) => network.allowPrivateNetworks || isGloballyRoutable(address);
  // Node.js does not call the lookup for an address, so the server checks it here.
  if (isIP(host) !== 0 && !accepts(host)) return Promise.resolve({ failure: "connection_refused" });

  return new Promise((resolve) => {
    let settled = false;
    const settle = (posted: Posted) => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(posted);
    };
    const request = httpsRequest(
      {
        method: "POST",
        host,
        port: url.port === "" ? 443 : Number(url.port),
        path: `${url.pathname}${url.search}`,
        headers: { ...headers, "Content-Length": String(Buffer.byteLength(body)) },
        agent: false,
        ...(isIP(host) === 0 ? { servername: host } : {}),
        ...(network.ca === undefined ? {} : { ca: [...network.ca] }),
        lookup: (hostname, lookupOptions, callback) => {
          dnsLookup(hostname, { all: true, family: lookupOptions.family ?? 0 }, (error, addresses: LookupAddress[]) => {
            if (error !== null) return callback(error, "", 0);
            const address = addresses.find((each) => accepts(each.address));
            if (address === undefined) return callback(new BlockedAddressError(`${hostname} has no address that the server accepts.`), "", 0);
            if (lookupOptions.all === true) return callback(null, [address]);
            callback(null, address.address, address.family);
          });
        },
      },
      (response) => {
        const chunks: Buffer[] = [];
        let length = 0;
        response.on("data", (chunk: unknown) => {
          if (!(chunk instanceof Buffer)) return;
          length += chunk.length;
          if (length <= MAXIMUM_ANSWER_BYTES) chunks.push(chunk);
        });
        response.on("end", () => settle({ status: response.statusCode ?? 0, text: Buffer.concat(chunks).toString("utf8") }));
        response.on("error", () => settle({ status: response.statusCode ?? 0, text: "" }));
      },
    );
    const timer = setTimeout(() => {
      settle({ failure: "timeout" });
      request.destroy();
    }, network.timeoutMs);
    request.on("error", (error) => settle({ failure: failureOf(error) }));
    request.end(body);
  });
}

/** The category of an error of the network. */
function failureOf(error: Error): WebhookError {
  const code = "code" in error && typeof error.code === "string" ? error.code : "";
  if (code === "ETIMEDOUT" || code === "ESOCKETTIMEDOUT") return "timeout";
  if (/^(ERR_TLS|ERR_SSL|CERT_|UNABLE_TO_|DEPTH_ZERO|SELF_SIGNED|HOSTNAME_MISMATCH)/.test(code) || /certificate|SSL|TLS/i.test(error.message)) return "tls_error";
  return "connection_refused";
}
