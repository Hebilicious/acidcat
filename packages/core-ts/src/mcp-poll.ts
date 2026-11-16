import { canonicalJson, decodePollCursor, encodePollCursor, MCP_EVENT_ERRORS, MCP_POLL_DEFAULTS, mcpSubscribeError } from "@acid-cat/spec-ts";
import type { JsonObject, Occurrence } from "@acid-cat/spec-ts";

import { backgroundClock } from "./clock.ts";
import type { Clock } from "./clock.ts";
import { endMessage, invalidParams, subscriptionParams } from "./mcp-events.ts";
import type { JsonRpcError, OpenSession, OwnSession, RpcAnswer } from "./mcp-events.ts";
import { subscribeWithMaxAge } from "./session.ts";
import type { MaxAge } from "./session.ts";
import type { Occurrences } from "./subscription.ts";

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
  newest: number;
  readonly startProvider: string | undefined;
  lastProvider: string | undefined;
  failure: string | undefined;
  ended: boolean;
  cancelTimer: () => void;
}

export class PollLeases {
  readonly #leases = new Map<string, Lease>();
  readonly #starting = new Map<string, Promise<unknown>>();
  readonly #leaseMs: number;
  readonly #bufferLimit: number;
  readonly #maxEvents: number;
  readonly #nextPollMs: number;
  readonly #clock: Clock;
  #closed = false;

  constructor(options: PollOptions = {}, clock: Clock = backgroundClock) {
    this.#leaseMs = options.leaseMs ?? MCP_POLL_DEFAULTS.leaseMs;
    this.#bufferLimit = options.bufferLimit ?? MCP_POLL_DEFAULTS.bufferLimit;
    this.#maxEvents = options.maxEvents ?? MCP_POLL_DEFAULTS.maxEvents;
    this.#nextPollMs = options.nextPollMs ?? MCP_POLL_DEFAULTS.nextPollMs;
    this.#clock = clock;
  }

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
      const provider = read.cursor === undefined ? undefined : position?.provider;
      const started = this.#start(key, read.name, read.input, provider, newLeaseMaxAge(provider, read.maxAge), open);
      this.#starting.set(key, started);
      const answer = await started.finally(() => this.#starting.delete(key));
      if ("error" in answer) return answer;
      return this.#result([], this.#cursorOf(answer, 0), read.cursor !== undefined && provider === undefined, false);
    }

    if (read.maxAge.kind === "invalid") return invalidParams("maxAgeMs must be an integer that is 0 or more.");
    this.#renew(lease);
    if (read.cursor === undefined) return this.#result([], this.#cursorOf(lease, lease.newest), false, false);
    if (position?.lease === lease.id) return this.#read(lease, position.position, maxEvents, read.cursor);
    // A cursor of another lease, while a lease with this key exists: the newest position, and the client can have missed
    // occurrences (spec/bindings/mcp.md#poll).
    return this.#result([], this.#cursorOf(lease, lease.newest), true, false);
  }

  async close(): Promise<void> {
    this.#closed = true;
    await Promise.allSettled(this.#starting.values());
    await Promise.allSettled([...this.#leases.values()].map((lease) => this.#end(lease)));
  }

  async #start(key: string, name: string, input: unknown, provider: string | undefined, maxAge: MaxAge, open: OpenSession): Promise<Lease | { readonly error: JsonRpcError }> {
    const own = await open();
    const subscribed = await subscribeWithMaxAge(own.session, name, input, { cursor: provider, maxAge });
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
    if (!lease.ended) await lease.own.close();
  }

  #renew(lease: Lease): void {
    lease.cancelTimer();
    lease.cancelTimer = this.#clock.schedule(() => void this.#end(lease), this.#leaseMs);
  }

  async #end(lease: Lease): Promise<void> {
    if (lease.ended) return;
    lease.ended = true;
    lease.cancelTimer();
    if (this.#leases.get(lease.key) === lease) this.#leases.delete(lease.key);
    await lease.occurrences.return();
    await lease.own.close();
  }

  #read(lease: Lease, after: number, maxEvents: number, requestCursor: string): RpcAnswer {
    const oldest = lease.entries[0]?.position ?? lease.newest + 1;
    const older = after < oldest - 1;
    const available = lease.entries.filter((entry) => entry.position > after);
    const events = available.slice(0, maxEvents);
    const last = events.at(-1);
    const truncated = older || events.some((entry) => entry.occurrence.truncated === true);
    return this.#result(events.map((entry) => withoutTruncated(entry.occurrence)), last === undefined ? requestCursor : this.#cursorOf(lease, last.position), truncated, available.length > maxEvents);
  }

  #cursorOf(lease: Lease, position: number): string {
    const provider = position === 0 ? lease.startProvider : position >= lease.newest ? lease.lastProvider : lease.entries.find((entry) => entry.position === position)?.provider;
    return encodePollCursor(provider === undefined ? { lease: lease.id, position } : { lease: lease.id, position, provider });
  }

  #result(events: readonly JsonObject[], cursor: string, truncated: boolean, hasMore: boolean): RpcAnswer {
    return { result: { events: [...events], cursor, truncated, hasMore, nextPollMs: this.#nextPollMs } };
  }
}

/**
 * The `maxAgeMs` of a new lease. A new lease resumes after the cursor of the provider, if the request gives one. With no
 * such cursor, a valid `maxAgeMs` changes nothing. An invalid one still fails.
 */
function newLeaseMaxAge(provider: string | undefined, maxAge: MaxAge): MaxAge {
  return provider === undefined && maxAge.kind === "valid" ? { kind: "absent" } : maxAge;
}

function withoutTruncated(occurrence: Occurrence): JsonObject {
  const { truncated: _, ...rest } = occurrence;
  return { ...rest };
}
