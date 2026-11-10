/**
 * Poll leases (spec/bindings/mcp.md#poll): the answer to `events/poll`. A lease holds one subscription, in a session of
 * its own, and a buffer of its occurrences. The leases live in the scope of the server, not in the scope of a request.
 */
import { canonicalJson, decodePollCursor, encodePollCursor, MCP_EVENT_ERRORS, MCP_POLL_DEFAULTS, mcpSubscribeError } from "@acid-cat/spec-ts";
import type { JsonObject, Occurrence, Resume } from "@acid-cat/spec-ts";
import { Clock, Effect, Exit, Fiber, Option, Scope, Semaphore, Stream } from "effect";

import type * as Session from "../Session.ts";

/** The settings of poll delivery. Each one has the default of the specification. */
export interface PollOptions {
  /** The time in milliseconds after the last poll at which a lease ends, and its subscription is cancelled. The default is 300 000. */
  readonly leaseMs?: number | undefined;
  /** The number of occurrences that a lease keeps. When the buffer is full, the lease removes the oldest one. The default is 1000. */
  readonly bufferLimit?: number | undefined;
  /** The number of occurrences in a result when the request has no `maxEvents`. The default is 100. */
  readonly maxEvents?: number | undefined;
  /** The `nextPollMs` of each result. The default is 2000. */
  readonly nextPollMs?: number | undefined;
}

/** Open a session in a scope, with the services of the request that starts a lease or a webhook subscription. */
export type Opener<R> = (scope: Scope.Scope) => Effect.Effect<Session.Session<R>>;

/** The params of `events/poll`, after they are decoded. */
export interface PollParams {
  readonly name: string;
  readonly input: unknown;
  readonly cursor: string | undefined;
  readonly maxAgeMs: number | undefined;
  readonly maxEvents: number | undefined;
}

/** The result of a poll, or a JSON-RPC error. */
export type PollAnswer = { readonly result: JsonObject } | { readonly error: { readonly code: number; readonly message: string; readonly data?: JsonObject } };

export interface Polls {
  readonly poll: <R>(params: PollParams, principal: Option.Option<string>, open: Opener<R>) => Effect.Effect<PollAnswer>;
}

/** One occurrence in the buffer of a lease, at its position, with the last cursor of the provider at that position. */
interface Entry {
  readonly position: number;
  readonly provider: string | undefined;
  readonly occurrence: Occurrence;
}

interface Lease {
  readonly id: string;
  readonly key: string;
  readonly scope: Scope.Closeable;
  /** The cursor of the provider at position 0: the cursor that the subscription resumed after, if any. */
  readonly startProvider: string | undefined;
  readonly entries: Entry[];
  newest: number;
  newestProvider: string | undefined;
  /** The message of the call failure `internal`, when the subscription ended with it. */
  failure: string | undefined;
  expiresAt: number;
  worker: Fiber.Fiber<void> | undefined;
}

/** The leases of a server, while the scope is open. When the scope closes, each lease ends. */
export const makePolls = (options: PollOptions = {}): Effect.Effect<Polls, never, Scope.Scope> =>
  Effect.gen(function* () {
    const leaseMs = options.leaseMs ?? MCP_POLL_DEFAULTS.leaseMs;
    const bufferLimit = Math.max(1, options.bufferLimit ?? MCP_POLL_DEFAULTS.bufferLimit);
    const defaultMaxEvents = Math.max(1, options.maxEvents ?? MCP_POLL_DEFAULTS.maxEvents);
    const nextPollMs = options.nextPollMs ?? MCP_POLL_DEFAULTS.nextPollMs;
    const serverScope = yield* Effect.scope;
    const leases = new Map<string, Lease>();
    const lock = yield* Semaphore.make(1);

    const cursorOf = (lease: Lease, position: number, provider: string | undefined) =>
      encodePollCursor(provider === undefined ? { lease: lease.id, position } : { lease: lease.id, position, provider });
    const newestCursor = (lease: Lease) => cursorOf(lease, lease.newest, lease.newestProvider);
    const result = (events: readonly Occurrence[], cursor: string, truncated: boolean, hasMore: boolean): PollAnswer => ({
      result: {
        resultType: "complete",
        events: events.map((each) => {
          const { truncated: _, ...rest } = each;
          return rest;
        }),
        cursor,
        truncated: truncated || events.some((each) => each.truncated === true),
        hasMore,
        nextPollMs,
      },
    });
    const renew = (lease: Lease) => Effect.map(Clock.currentTimeMillis, (now) => void (lease.expiresAt = now + leaseMs));

    /** Wait until the lease gets no poll for the lease time. */
    const expiry = (lease: Lease) =>
      Effect.gen(function* () {
        for (;;) {
          const wait = lease.expiresAt - (yield* Clock.currentTimeMillis);
          if (wait <= 0) return;
          yield* Effect.sleep(wait);
        }
      });

    /** Keep each occurrence of the subscription in the buffer of the lease. */
    const consume = (lease: Lease, subscription: Session.Subscription<unknown>) =>
      Stream.runForEach(subscription, (occurrence) =>
        Effect.sync(() => {
          lease.newest += 1;
          if (occurrence.cursor !== undefined) lease.newestProvider = occurrence.cursor;
          lease.entries.push({ position: lease.newest, provider: lease.newestProvider, occurrence });
          if (lease.entries.length > bufferLimit) lease.entries.shift();
        }),
      ).pipe(
        Effect.catchTag("CallFailed", (failure) => Effect.sync(() => void (lease.failure = failure.message))),
        // A complete subscription keeps its buffer until the lease ends.
        Effect.andThen(Effect.never),
      );

    /** Start a lease with a new subscription in a session of its own. A failure before the first occurrence starts no lease. */
    const start = <R>(key: string, params: PollParams, resume: Resume, open: Opener<R>): Effect.Effect<Lease | PollAnswer> =>
      Effect.gen(function* () {
        const scope = yield* Scope.make();
        const session = yield* open(scope);
        const started = yield* Effect.result(session.subscribe(params.name, params.input, resume).pipe(Scope.provide(scope)));
        if (started._tag === "Failure") {
          yield* Scope.close(scope, Exit.void);
          return { error: mcpSubscribeError({ kind: started.failure.kind, message: started.failure.message }) };
        }
        const lease: Lease = {
          id: globalThis.crypto.randomUUID(),
          key,
          scope,
          startProvider: resume.cursor,
          entries: [],
          newest: 0,
          newestProvider: resume.cursor,
          failure: undefined,
          expiresAt: 0,
          worker: undefined,
        };
        yield* renew(lease);
        leases.set(key, lease);
        const cleanup = Effect.suspend(() => {
          if (leases.get(key) === lease) leases.delete(key);
          return Scope.close(scope, Exit.void);
        });
        lease.worker = yield* Effect.raceFirst(consume(lease, started.success), expiry(lease)).pipe(
          Effect.ensuring(cleanup),
          Effect.forkIn(serverScope, { startImmediately: true }),
        );
        return lease;
      });

    const end = (lease: Lease) => (lease.worker === undefined ? Effect.void : Fiber.interrupt(lease.worker));

    const poll: Polls["poll"] = (params, principal, open) =>
      lock.withPermit(
        Effect.gen(function* () {
          const key = canonicalJson([Option.getOrNull(principal), params.name, params.input]);
          const lease = leases.get(key);
          if (lease?.failure !== undefined) {
            yield* end(lease);
            return { error: { code: MCP_EVENT_ERRORS.internal, message: lease.failure } };
          }
          const decoded = params.cursor === undefined ? undefined : decodePollCursor(params.cursor);

          if (lease !== undefined && params.cursor === undefined) {
            yield* renew(lease);
            return result([], newestCursor(lease), false, false);
          }
          if (lease !== undefined && params.cursor !== undefined && decoded?.lease === lease.id) {
            yield* renew(lease);
            const oldest = lease.entries[0]?.position ?? lease.newest + 1;
            const after = lease.entries.filter((entry) => entry.position > decoded.position);
            const batch = after.slice(0, params.maxEvents ?? defaultMaxEvents);
            const last = batch.at(-1);
            const cursor = last === undefined ? params.cursor : cursorOf(lease, last.position, last.provider);
            return result(
              batch.map((entry) => entry.occurrence),
              cursor,
              decoded.position < oldest - 1,
              after.length > batch.length,
            );
          }
          if (lease !== undefined) {
            // A cursor of another lease, for a key that has a lease: the client can have missed occurrences.
            yield* renew(lease);
            return result([], newestCursor(lease), true, false);
          }
          // No lease. A cursor of a lease that ended resumes after the last cursor of the provider in it.
          const provider = decoded?.provider;
          const resume: Resume =
            provider === undefined ? {} : { cursor: provider, ...(params.maxAgeMs === undefined ? {} : { maxAgeMs: params.maxAgeMs }) };
          const started = yield* start(key, params, resume, open);
          if (!("id" in started)) return started;
          return result([], cursorOf(started, 0, started.startProvider), params.cursor !== undefined && provider === undefined, false);
        }),
      );

    return { poll };
  });
