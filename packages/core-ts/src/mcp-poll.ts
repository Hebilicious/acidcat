/**
 * Poll delivery through MCP (spec/bindings/mcp.md#poll): `events/poll` reads the occurrences of a poll lease. A lease
 * holds one subscription, in a session of its own, and a buffer of its occurrences. The HTTP and the stdio transports
 * share this module. It works in all runtimes.
 */
import { canonicalJson, decodePollCursor, encodePollCursor, MCP_EVENT_ERRORS, MCP_POLL_DEFAULTS, mcpSubscribeError } from "@acid-cat/spec-ts";
import type { JsonObject, Occurrence } from "@acid-cat/spec-ts";

import { systemClock } from "./clock.ts";
import type { Clock } from "./clock.ts";
import { endMessage, invalidParams, subscriptionParams } from "./mcp-events.ts";
import type { JsonRpcError, OpenSession, OwnSession, RpcAnswer } from "./mcp-events.ts";
import { isMaxAgeMs } from "./session.ts";
import type { Occurrences } from "./subscription.ts";

/** The settings of poll delivery. Each one has the default of spec/bindings/mcp.md#poll. */
export interface PollOptions {
  /** The time after the last poll at which a lease ends, in milliseconds. The default is 5 minutes. */
  readonly leaseMs?: number | undefined;
  /** The number of occurrences that each lease keeps. The default is 1000. */
  readonly bufferLimit?: number | undefined;
  /** The number of occurrences in a result when the request gives no `maxEvents`. The default is 100. */
  readonly maxEvents?: number | undefined;
  /** The `nextPollMs` of each result. The default is 2000. */
  readonly nextPollMs?: number | undefined;
}

/** One occurrence in the buffer of a lease, with its position and the last cursor of the provider at that position. */
interface Entry {
  readonly position: number;
  readonly occurrence: Occurrence;
  readonly provider: string | undefined;
}

interface Lease {
  readonly id: string;
  readonly key: string;
  readonly own: OwnSession;
  readonly occurrences: Occurrences<unknown>;
  readonly entries: Entry[];
  /** The position of the newest occurrence. The start of the lease is position 0. */
  newest: number;
  /** The cursor of the provider at the start of the lease: the cursor that the subscription resumed after, if any. */
  readonly startProvider: string | undefined;
  /** The cursor of the last occurrence that the provider gave, or the cursor at the start. */
  lastProvider: string | undefined;
  /** The message of the call failure `internal` that ended the subscription. */
  failure: string | undefined;
  ended: boolean;
  cancelTimer: () => void;
}

/** The poll leases of one server. `close` ends them all. */
export class PollLeases {
  readonly #leases = new Map<string, Lease>();
  /** The leases that start, by key. A second poll with the same key waits for the first. */
  readonly #starting = new Map<string, Promise<unknown>>();
  readonly #leaseMs: number;
  readonly #bufferLimit: number;
  readonly #maxEvents: number;
  readonly #nextPollMs: number;
  readonly #clock: Clock;
  #closed = false;

  constructor(options: PollOptions = {}, clock: Clock = systemClock) {
    this.#leaseMs = options.leaseMs ?? MCP_POLL_DEFAULTS.leaseMs;
    this.#bufferLimit = options.bufferLimit ?? MCP_POLL_DEFAULTS.bufferLimit;
    this.#maxEvents = options.maxEvents ?? MCP_POLL_DEFAULTS.maxEvents;
    this.#nextPollMs = options.nextPollMs ?? MCP_POLL_DEFAULTS.nextPollMs;
    this.#clock = clock;
  }

  /** The number of leases, for tests. */
  get size(): number {
    return this.#leases.size;
  }

  /**
   * Answer `events/poll`. `principal` is the identity of the client, or `undefined` if the deployment gives none.
   * `open` opens the session of a new lease.
   */
  async poll(principal: string | undefined, params: JsonObject, open: OpenSession): Promise<RpcAnswer> {
    const read = subscriptionParams(params);
    if ("error" in read) return read;
    const { maxEvents = this.#maxEvents } = params;
    if (typeof maxEvents !== "number" || !Number.isSafeInteger(maxEvents) || maxEvents < 1) return invalidParams("maxEvents must be a positive integer.");
    const key = canonicalJson([principal ?? null, read.name, read.input]);
    await this.#starting.get(key);

    const lease = this.#leases.get(key);
    if (lease?.failure !== undefined) {
      await this.#end(lease);
      return { error: { code: MCP_EVENT_ERRORS.internal, message: lease.failure } };
    }
    const position = read.cursor === undefined ? undefined : decodePollCursor(read.cursor);

    if (lease === undefined) {
      // A cursor that is not of a lease that exists: resume after the cursor of the provider, if the cursor has one.
      const provider = read.cursor === undefined ? undefined : position?.provider;
      // With no cursor of the provider, a valid maxAgeMs changes nothing. The session still rejects one that is not valid.
      const maxAgeMs = provider === undefined && isMaxAgeMs(read.maxAgeMs) ? undefined : read.maxAgeMs;
      const started = this.#start(key, read.name, read.input, provider, maxAgeMs, open);
      this.#starting.set(key, started);
      const answer = await started.finally(() => this.#starting.delete(key));
      if ("error" in answer) return answer;
      return this.#result([], this.#cursorOf(answer, 0), read.cursor !== undefined && provider === undefined, false);
    }

    // A lease with this key exists, so the event exists: an invalid maxAgeMs is the next failure that applies.
    if (!isMaxAgeMs(read.maxAgeMs)) return invalidParams("maxAgeMs must be an integer that is 0 or more.");
    this.#renew(lease);
    if (read.cursor === undefined) return this.#result([], this.#cursorOf(lease, lease.newest), false, false);
    if (position?.lease === lease.id) return this.#read(lease, position.position, maxEvents, read.cursor);
    // A cursor of another lease, while a lease with this key exists: the newest position, and the client can have missed
    // occurrences (spec/bindings/mcp.md#poll).
    return this.#result([], this.#cursorOf(lease, lease.newest), true, false);
  }

  /** End all leases. */
  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#starting.values());
    await Promise.allSettled([...this.#leases.values()].map((lease) => this.#end(lease)));
  }

  /** Start a lease: open its session, subscribe, and keep the occurrences. A failure before the first occurrence starts no lease. */
  async #start(key: string, name: string, input: unknown, provider: string | undefined, maxAgeMs: number | undefined, open: OpenSession): Promise<Lease | { readonly error: JsonRpcError }> {
    const own = await open();
    const subscribed = await own.session.subscribe(name, input, {
      ...(provider === undefined ? {} : { cursor: provider }),
      ...(maxAgeMs === undefined ? {} : { maxAgeMs }),
    });
    if ("kind" in subscribed || this.#closed) {
      if (!("kind" in subscribed)) await subscribed.return();
      await own.close();
      if ("kind" in subscribed) return { error: mcpSubscribeError(subscribed) };
      return { error: { code: MCP_EVENT_ERRORS.internal, message: "The server is closing." } };
    }
    const lease: Lease = {
      id: crypto.randomUUID(),
      key,
      own,
      occurrences: subscribed,
      entries: [],
      newest: 0,
      startProvider: provider,
      lastProvider: provider,
      failure: undefined,
      ended: false,
      cancelTimer: () => {},
    };
    this.#leases.set(key, lease);
    this.#renew(lease);
    void this.#pump(lease);
    return lease;
  }

  /** Read the occurrences of the subscription of a lease into its buffer, until the subscription ends. */
  async #pump(lease: Lease): Promise<void> {
    try {
      for (let step = await lease.occurrences.next(); step.done !== true; step = await lease.occurrences.next()) {
        const occurrence = step.value;
        if (occurrence.cursor !== undefined) lease.lastProvider = occurrence.cursor;
        lease.newest += 1;
        lease.entries.push({ position: lease.newest, occurrence, provider: lease.lastProvider });
        if (lease.entries.length > this.#bufferLimit) lease.entries.shift();
      }
    } catch (error) {
      if (!lease.ended) lease.failure = endMessage(error);
    }
    // The subscription is complete or failed. The lease keeps its buffer until it ends, but its session can close.
    if (!lease.ended) await lease.own.close();
  }

  /** Renew a lease: it ends when it gets no poll for the lease time. */
  #renew(lease: Lease): void {
    lease.cancelTimer();
    lease.cancelTimer = this.#clock.schedule(() => void this.#end(lease), this.#leaseMs);
  }

  /** End a lease: cancel its subscription, close its session, and forget it. */
  async #end(lease: Lease): Promise<void> {
    if (lease.ended) return;
    lease.ended = true;
    lease.cancelTimer();
    if (this.#leases.get(lease.key) === lease) this.#leases.delete(lease.key);
    await lease.occurrences.return();
    await lease.own.close();
  }

  /** The occurrences of a lease after a position, at most `maxEvents`. */
  #read(lease: Lease, after: number, maxEvents: number, requestCursor: string): RpcAnswer {
    const oldest = lease.entries[0]?.position ?? lease.newest + 1;
    const older = after < oldest - 1;
    const available = lease.entries.filter((entry) => entry.position > after);
    const events = available.slice(0, maxEvents);
    const last = events.at(-1);
    const truncated = older || events.some((entry) => entry.occurrence.truncated === true);
    return this.#result(events.map((entry) => withoutTruncated(entry.occurrence)), last === undefined ? requestCursor : this.#cursorOf(lease, last.position), truncated, available.length > maxEvents);
  }

  /** The cursor of a position of a lease. */
  #cursorOf(lease: Lease, position: number): string {
    const provider = position === 0 ? lease.startProvider : position >= lease.newest ? lease.lastProvider : lease.entries.find((entry) => entry.position === position)?.provider;
    return encodePollCursor(provider === undefined ? { lease: lease.id, position } : { lease: lease.id, position, provider });
  }

  #result(events: readonly JsonObject[], cursor: string, truncated: boolean, hasMore: boolean): RpcAnswer {
    return { result: { events: [...events], cursor, truncated, hasMore, nextPollMs: this.#nextPollMs } };
  }
}

/** An occurrence without `truncated`, as an item of `events`. */
function withoutTruncated(occurrence: Occurrence): JsonObject {
  const { truncated: _, ...rest } = occurrence;
  return { ...rest };
}
