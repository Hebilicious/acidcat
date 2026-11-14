/**
 * Webhook delivery (spec/bindings/mcp.md#webhook): the answers to `events/subscribe` and `events/unsubscribe`, and the
 * deliveries of each webhook subscription. A subscription holds one subscription of an event, in a session of its own.
 * The subscriptions live in the scope of the server, not in the scope of a request. The sender does the HTTP requests,
 * so this module works in all runtimes.
 */
import { callFailure, canonicalJson, isJsonObject, MCP_EVENT_ERRORS, MCP_WEBHOOK_DEFAULTS, mcpSubscribeError, webhookGrantMs, webhookSecretBytes, webhookSignature, webhookSubscriptionId } from "@acid-cat/spec-ts";
import type { JsonObject, Occurrence, Resume, WebhookError } from "@acid-cat/spec-ts";
import { Clock, Data, Effect, Exit, Fiber, Option, Schedule, Schema, Scope, Semaphore, Stream } from "effect";

import type { Opener } from "./poll.ts";
import { maxAgeOf, resumeIssue } from "./resume.ts";

/** One HTTP `POST` to the URL of a webhook subscription. */
export interface WebhookRequest {
  readonly url: URL;
  readonly headers: { readonly [name: string]: string };
  readonly body: string;
}

/** The answer of the endpoint: its status, and the start of its body as text. */
export interface WebhookResponse {
  readonly status: number;
  readonly body: string;
}

/**
 * The request did not get an answer. `reason` is the category of the problem: the connection was refused or not
 * allowed, it took too long, or TLS failed.
 */
export class WebhookSendError extends Data.TaggedError("WebhookSendError")<{ readonly reason: "connection_refused" | "timeout" | "tls_error" }> {}

/**
 * Send one request, and give the answer. The sender MUST NOT follow redirects. It MUST connect only to the addresses
 * that the network policy of the deployment allows. Interruption cancels the request. `NodeWebhook.sender` is a sender
 * for Node.js.
 */
export type WebhookSender = (request: WebhookRequest) => Effect.Effect<WebhookResponse, WebhookSendError>;

/** The settings of webhook delivery. Webhook delivery is off when the server has no settings. */
export interface WebhookOptions {
  /** Send the requests. */
  readonly sender: WebhookSender;
  /** The URLs that need no verification: they agree to get deliveries. With no function, each URL is verified. */
  readonly allow?: ((url: URL) => boolean) | undefined;
  /** The maximum lifetime of a subscription, in milliseconds. The default is 3 600 000. */
  readonly maxTtlMs?: number | undefined;
  /** The minimum lifetime of a subscription, in milliseconds. The default is 60 000. */
  readonly minTtlMs?: number | undefined;
  /** The maximum number of webhook subscriptions of one principal. The default is 100. */
  readonly maxSubscriptions?: number | undefined;
  /** The maximum number of attempts of one delivery. The default is 5. */
  readonly attempts?: number | undefined;
  /** The time in milliseconds after the first attempt of a delivery after which the server makes no more attempts. The default is 900 000. */
  readonly retryWindowMs?: number | undefined;
  /** The time in milliseconds that the server waits for each answer. The default is 5000. */
  readonly timeoutMs?: number | undefined;
  /** The time in milliseconds after a change of the secret during which the server signs with the old and the new secret. The default is 300 000. */
  readonly rotationGraceMs?: number | undefined;
  /**
   * The waits between the attempts of one delivery. The server stops at `attempts` attempts, or after
   * `retryWindowMs`. The default is exponential: 5 seconds, then 4 times longer each time.
   */
  readonly retryDelays?: Schedule.Schedule<unknown> | undefined;
}

/** A JSON-RPC error. */
export interface RpcError {
  readonly code: number;
  readonly message: string;
  readonly data?: JsonObject;
}

export type WebhookAnswer = { readonly result: JsonObject } | { readonly error: RpcError };

export interface Webhooks {
  readonly subscribe: <R>(params: JsonObject, principal: Option.Option<string>, open: Opener<R>) => Effect.Effect<WebhookAnswer>;
  readonly unsubscribe: (params: JsonObject, principal: Option.Option<string>) => Effect.Effect<WebhookAnswer>;
}

const nonNegative = Schema.Int.check(Schema.isGreaterThanOrEqualTo(0));

const SubscribeParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Unknown),
  delivery: Schema.Struct({ mode: Schema.Literal("webhook"), url: Schema.String, secret: Schema.String }),
  cursor: Schema.optionalKey(Schema.NullOr(Schema.String)),
  // Any value: the session checks `maxAgeMs` after it looks up the name (spec/events.md#subscribing).
  maxAgeMs: Schema.optionalKey(Schema.Unknown),
  ttlMs: Schema.optionalKey(Schema.NullOr(nonNegative)),
});

const UnsubscribeParams = Schema.Struct({
  name: Schema.String,
  arguments: Schema.optionalKey(Schema.Unknown),
  delivery: Schema.Struct({ url: Schema.String }),
});

/** One webhook subscription. */
interface Hook {
  readonly id: string;
  readonly key: string;
  readonly principal: string;
  readonly url: URL;
  readonly scope: Scope.Closeable;
  secret: string;
  previous: { readonly secret: string; readonly until: number } | undefined;
  expiresAt: number;
  watermark: string | null;
  lastDeliveryAt: string | null;
  lastError: WebhookError | null;
  worker: Fiber.Fiber<void> | undefined;
}

/** An attempt of a delivery that failed. A failure that is not retryable abandons the delivery. */
class AttemptFailed extends Data.TaggedError("AttemptFailed")<{ readonly reason: WebhookError; readonly retryable: boolean }> {}

const invalidParams = (message: string): WebhookAnswer => ({ error: { code: MCP_EVENT_ERRORS.invalidParams, message } });

const forbidden: WebhookAnswer = {
  error: { code: MCP_EVENT_ERRORS.forbidden, message: "Webhook delivery needs the identity of the client." },
};

/** The webhook subscriptions of a server, while the scope is open. When the scope closes, each subscription ends. */
export const makeWebhooks = (options: WebhookOptions): Effect.Effect<Webhooks, never, Scope.Scope> =>
  Effect.gen(function* () {
    const limits = {
      maxTtlMs: options.maxTtlMs ?? MCP_WEBHOOK_DEFAULTS.maxTtlMs,
      minTtlMs: options.minTtlMs ?? MCP_WEBHOOK_DEFAULTS.minTtlMs,
    };
    const maxSubscriptions = options.maxSubscriptions ?? MCP_WEBHOOK_DEFAULTS.maxSubscriptions;
    const attempts = Math.max(1, options.attempts ?? MCP_WEBHOOK_DEFAULTS.attempts);
    const retryWindowMs = options.retryWindowMs ?? MCP_WEBHOOK_DEFAULTS.retryWindowMs;
    const timeoutMs = options.timeoutMs ?? MCP_WEBHOOK_DEFAULTS.timeoutMs;
    const rotationGraceMs = options.rotationGraceMs ?? MCP_WEBHOOK_DEFAULTS.rotationGraceMs;
    const retries = (options.retryDelays ?? Schedule.exponential("5 seconds", 4)).pipe(Schedule.upTo({ times: attempts - 1, duration: retryWindowMs }));
    const serverScope = yield* Effect.scope;

    const hooks = new Map<string, Hook>();
    /** The verifications that succeeded, by principal and URL, while the server runs. */
    const verified = new Set<string>();
    /** The new subscriptions of each principal that are starting now, so that they count for the limit. */
    const starting = new Map<string, number>();
    const locks = new Map<string, { readonly semaphore: Semaphore.Semaphore; users: number }>();

    /** Run an effect with the lock of a key. The lock exists only while an effect uses it. */
    const withKey = <A>(key: string, effect: Effect.Effect<A>): Effect.Effect<A> =>
      Effect.acquireUseRelease(
        Effect.sync(() => {
          const lock = locks.get(key) ?? { semaphore: Semaphore.makeUnsafe(1), users: 0 };
          lock.users += 1;
          locks.set(key, lock);
          return lock;
        }),
        (lock) => lock.semaphore.withPermit(effect),
        (lock) =>
          Effect.sync(() => {
            lock.users -= 1;
            if (lock.users === 0) locks.delete(key);
          }),
      );

    const count = (principal: string) => [...hooks.values()].filter((hook) => hook.principal === principal).length + (starting.get(principal) ?? 0);

    const secretsAt = (hook: Hook, now: number) =>
      hook.previous !== undefined && hook.previous.until > now ? [hook.secret, hook.previous.secret] : [hook.secret];

    /** One attempt of a request, signed with the secrets of now. */
    const attempt = (url: URL, id: string, webhookId: string, body: string, secrets: (now: number) => readonly string[]) =>
      Effect.gen(function* () {
        const now = yield* Clock.currentTimeMillis;
        const timestamp = Math.floor(now / 1000);
        const signature = yield* Effect.promise(() => webhookSignature(secrets(now), webhookId, timestamp, body));
        const headers = {
          "Content-Type": "application/json",
          "webhook-id": webhookId,
          "webhook-timestamp": String(timestamp),
          "webhook-signature": signature,
          "X-MCP-Subscription-Id": id,
        };
        return yield* options.sender({ url, headers, body }).pipe(
          Effect.timeoutOrElse({ duration: timeoutMs, orElse: () => Effect.fail(new WebhookSendError({ reason: "timeout" })) }),
        );
      });

    /**
     * Deliver one message, with retries. The result is the category of the last failure, or `null` when the delivery
     * succeeded. A delivery that fails each time is abandoned.
     */
    const deliver = (hook: Hook, webhookId: string, body: string): Effect.Effect<WebhookError | null> =>
      attempt(hook.url, hook.id, webhookId, body, (now) => secretsAt(hook, now)).pipe(
        Effect.mapError((error) => new AttemptFailed({ reason: error.reason, retryable: true })),
        Effect.flatMap((response) => {
          if (response.status >= 200 && response.status < 300) return Effect.void;
          const reason: WebhookError = response.status >= 500 ? "http_5xx" : "http_4xx";
          return Effect.fail(new AttemptFailed({ reason, retryable: response.status !== 410 && response.status !== 413 }));
        }),
        Effect.retry({ schedule: retries, while: (error) => error.retryable }),
        Effect.as(null),
        Effect.catchTag("AttemptFailed", (error) => Effect.succeed(error.reason)),
        Effect.tap((failure) =>
          Effect.map(Clock.currentTimeMillis, (now) => {
            hook.lastError = failure;
            if (failure === null) hook.lastDeliveryAt = new Date(now).toISOString();
          }),
        ),
      );

    /**
     * Ask the endpoint whether it agrees to get deliveries: send a challenge, and compare the answer in constant time.
     * The result is `undefined` when it agrees, or the reason when it does not.
     */
    const verify = (url: URL, id: string, secret: string): Effect.Effect<WebhookError | undefined> => {
      const challenge = randomText(32);
      const body = JSON.stringify({ type: "verification", challenge });
      return attempt(url, id, messageId("verification"), body, () => [secret]).pipe(
        Effect.map((response): WebhookError | undefined => {
          if (response.status >= 500) return "http_5xx";
          if (response.status >= 400) return "http_4xx";
          if (response.status < 200 || response.status >= 300) return "challenge_failed";
          const answer = parseJson(response.body);
          return isJsonObject(answer) && typeof answer.challenge === "string" && equalInConstantTime(answer.challenge, challenge) ? undefined : "challenge_failed";
        }),
        Effect.catchTag("WebhookSendError", (error) => Effect.succeed(error.reason)),
      );
    };

    /** Send each occurrence of the subscription, one at a time and in order. The call failure `internal` sends `terminated`. */
    const run = (hook: Hook, subscription: Stream.Stream<Occurrence, { readonly message: string }>) =>
      Stream.runForEach(subscription, (occurrence) =>
        Effect.gen(function* () {
          if (occurrence.truncated === true) yield* deliver(hook, messageId("gap"), JSON.stringify({ type: "gap", cursor: hook.watermark }));
          const { truncated: _, cursor, ...rest } = occurrence;
          const watermark = cursor ?? hook.watermark;
          yield* deliver(hook, messageId(), JSON.stringify(watermark === null ? rest : { ...rest, cursor: watermark }));
          hook.watermark = watermark;
        }),
      ).pipe(
        Effect.catch((failure) =>
          Effect.asVoid(deliver(hook, messageId("terminated"), JSON.stringify({ type: "terminated", error: { code: MCP_EVENT_ERRORS.internal, message: failure.message } }))),
        ),
      );

    /** Wait until the lifetime of the subscription ends. */
    const expiry = (hook: Hook) =>
      Effect.gen(function* () {
        for (;;) {
          const wait = hook.expiresAt - (yield* Clock.currentTimeMillis);
          if (wait <= 0) return;
          yield* Effect.sleep(wait);
        }
      });

    const answerOf = (hook: Hook): WebhookAnswer => ({
      result: {
        resultType: "complete",
        id: hook.id,
        refreshBefore: new Date(hook.expiresAt).toISOString(),
        cursor: hook.watermark,
        truncated: false,
        deliveryStatus: { active: true, lastDeliveryAt: hook.lastDeliveryAt, lastError: hook.lastError },
      },
    });

    /** Start a new subscription: start the subscription of the event, verify the URL, and deliver. */
    const create = <R>(
      key: string,
      principal: string,
      params: typeof SubscribeParams.Type,
      url: URL,
      open: Opener<R>,
      release: () => void,
    ): Effect.Effect<WebhookAnswer> =>
      Effect.gen(function* () {
        const input = params.arguments ?? {};
        const id = yield* Effect.promise(() => webhookSubscriptionId(principal, params.delivery.url, params.name, input));
        const scope = yield* Scope.make();
        const maxAgeMs = maxAgeOf(params.maxAgeMs);
        const resume: Resume = {
          ...(typeof params.cursor === "string" ? { cursor: params.cursor } : {}),
          ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
        };
        const session = yield* open(scope);
        const started = yield* Effect.result(session.subscribe(params.name, input, resume).pipe(Scope.provide(scope)));
        if (started._tag === "Failure") {
          yield* Scope.close(scope, Exit.void);
          return { error: mcpSubscribeError({ kind: started.failure.kind, message: started.failure.message }) };
        }
        const pair = canonicalJson([principal, params.delivery.url]);
        if (!verified.has(pair) && options.allow?.(url) !== true) {
          const reason = yield* verify(url, id, params.delivery.secret);
          if (reason !== undefined) {
            yield* Scope.close(scope, Exit.void);
            return { error: { code: MCP_EVENT_ERRORS.callbackEndpoint, message: "The callback endpoint does not agree to get deliveries.", data: { reason } } };
          }
          verified.add(pair);
        }
        const now = yield* Clock.currentTimeMillis;
        const hook: Hook = {
          id,
          key,
          principal,
          url,
          scope,
          secret: params.delivery.secret,
          previous: undefined,
          expiresAt: now + webhookGrantMs(params.ttlMs, limits),
          watermark: null,
          lastDeliveryAt: null,
          lastError: null,
          worker: undefined,
        };
        // The subscription counts once: it leaves the starting count in the same step that adds it.
        release();
        hooks.set(key, hook);
        const cleanup = Effect.suspend(() => {
          if (hooks.get(key) === hook) hooks.delete(key);
          return Scope.close(scope, Exit.void);
        });
        hook.worker = yield* Effect.raceFirst(run(hook, started.success), expiry(hook)).pipe(
          Effect.ensuring(cleanup),
          Effect.forkIn(serverScope, { startImmediately: true }),
        );
        return answerOf(hook);
      });

    const subscribe: Webhooks["subscribe"] = (input, principalOption, open) =>
      Effect.gen(function* () {
        if (Option.isNone(principalOption)) return forbidden;
        const principal = principalOption.value;
        const decoded = yield* Effect.result(Schema.decodeUnknownEffect(SubscribeParams)(input));
        if (decoded._tag === "Failure") return invalidParams(`The params of events/subscribe are not valid: ${decoded.failure.message}`);
        const params = decoded.success;
        const url = parseUrl(params.delivery.url);
        if (url === undefined || url.protocol !== "https:") return invalidParams("The URL of a webhook must use https.");
        if (webhookSecretBytes(params.delivery.secret) === undefined) return invalidParams("The secret of a webhook must be whsec_ and the base64 of 24 to 64 bytes.");
        // The key and the subscription id use the URL as the client sent it, so that the client can compute the id.
        const key = canonicalJson([principal, params.delivery.url, params.name, params.arguments ?? {}]);
        return yield* withKey(
          key,
          Effect.gen(function* () {
            const hook = hooks.get(key);
            if (hook === undefined) {
              // The check and the count are one step, so that two new subscriptions cannot both pass the limit.
              const admitted = yield* Effect.sync(() => {
                if (count(principal) >= maxSubscriptions) return false;
                starting.set(principal, (starting.get(principal) ?? 0) + 1);
                return true;
              });
              if (!admitted) {
                return { error: { code: MCP_EVENT_ERRORS.resourceExhausted, message: "The principal has the maximum number of webhook subscriptions.", data: { limit: "subscriptions", max: maxSubscriptions } } };
              }
              let held = true;
              /** Stop counting the subscription as starting. It runs once: when the subscription exists, or when the start fails. */
              const release = () => {
                if (!held) return;
                held = false;
                const left = (starting.get(principal) ?? 1) - 1;
                if (left === 0) starting.delete(principal);
                else starting.set(principal, left);
              };
              return yield* create(key, principal, params, url, open, release).pipe(Effect.ensuring(Effect.sync(release)));
            }
            // A renewal starts no subscription, so the binding checks `maxAgeMs` here. The subscription exists, so the
            // name is known, and the failure is `invalid-input`.
            const maxAgeMs = maxAgeOf(params.maxAgeMs);
            const issue = maxAgeMs === undefined ? undefined : resumeIssue({ maxAgeMs });
            if (issue !== undefined) return { error: mcpSubscribeError(callFailure("invalid-input", issue)) };
            // Renew: a new lifetime, and the new secret. The old secret signs too, for the grace time.
            const now = yield* Clock.currentTimeMillis;
            hook.expiresAt = now + webhookGrantMs(params.ttlMs, limits);
            if (params.delivery.secret !== hook.secret) {
              hook.previous = { secret: hook.secret, until: now + rotationGraceMs };
              hook.secret = params.delivery.secret;
            }
            return answerOf(hook);
          }),
        );
      });

    const unsubscribe: Webhooks["unsubscribe"] = (input, principalOption) =>
      Effect.gen(function* () {
        if (Option.isNone(principalOption)) return forbidden;
        const decoded = yield* Effect.result(Schema.decodeUnknownEffect(UnsubscribeParams)(input));
        if (decoded._tag === "Failure") return invalidParams(`The params of events/unsubscribe are not valid: ${decoded.failure.message}`);
        const params = decoded.success;
        const key = canonicalJson([principalOption.value, params.delivery.url, params.name, params.arguments ?? {}]);
        const hook = hooks.get(key);
        if (hook === undefined) return { error: { code: MCP_EVENT_ERRORS.notFound, message: "There is no webhook subscription with this key.", data: { kind: "subscription" } } };
        if (hook.worker !== undefined) yield* Fiber.interrupt(hook.worker);
        return { result: { resultType: "complete" } };
      });

    return { subscribe, unsubscribe };
  });

function parseUrl(text: string): URL | undefined {
  try {
    return new URL(text);
  } catch {
    return undefined;
  }
}

function parseJson(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return undefined;
  }
}

const LETTERS = "ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";

/** Random letters and digits. */
function randomText(length: number): string {
  const bytes = globalThis.crypto.getRandomValues(new Uint8Array(length));
  return Array.from(bytes, (byte) => LETTERS.charAt(byte % LETTERS.length)).join("");
}

/** A `webhook-id`: `msg_` and random letters and digits, or `msg_<type>_` and random letters and digits for a control message. */
const messageId = (type?: string): string => (type === undefined ? `msg_${randomText(24)}` : `msg_${type}_${randomText(24)}`);

/** Compare two texts in a time that depends only on their lengths. */
function equalInConstantTime(a: string, b: string): boolean {
  const left = new TextEncoder().encode(a);
  const right = new TextEncoder().encode(b);
  const length = Math.max(left.length, right.length);
  let difference = left.length ^ right.length;
  for (let index = 0; index < length; index += 1) difference |= (left[index] ?? 0) ^ (right[index] ?? 0);
  return difference === 0;
}
