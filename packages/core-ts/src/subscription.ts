/**
 * One subscription (spec/events.md): the pump that reads the occurrences of the provider, the bounded buffer for a slow
 * client, and the iterator that the client reads.
 */
import { CallFailureError, callFailure, occurrenceOf } from "@acid-cat/spec-ts";
import type { Emitted, Occurrence } from "@acid-cat/spec-ts";

/**
 * The occurrences of one subscription, as an async iterator (spec/bindings/typescript.md#event-handles). `return()`
 * cancels the subscription, also while a `next()` waits: that `next()` then resolves with `done: true`. A `for await`
 * loop that stops early calls `return()`. `await using` also cancels the subscription at the end of its block.
 */
export interface Occurrences<Payload> extends AsyncIterable<Occurrence<Payload>>, AsyncDisposable {
  next(): Promise<IteratorResult<Occurrence<Payload>, undefined>>;
  return(): Promise<IteratorResult<Occurrence<Payload>, undefined>>;
  [Symbol.asyncIterator](): Occurrences<Payload>;
}

/** The number of occurrences that a subscription keeps for a client that reads slowly, if the session gives no limit. */
export const DEFAULT_BUFFER_LIMIT = 256;

/** The message of the call failure `internal` of a subscription. It shows no internal data. */
const INTERNAL_MESSAGE = "The event failed.";

const DONE: IteratorReturnResult<undefined> = { done: true, value: undefined };

export interface SubscriptionParts<Source, Payload> {
  /** The id of the event. */
  readonly name: string;
  /** The occurrences of the provider. The pump starts to read them at once. */
  readonly source: AsyncIterable<Emitted<Source>>;
  /** Check the data of one occurrence against the payload schema, and give a copy in its JSON form. It throws if the data does not agree. */
  readonly check: (data: Source) => Promise<Payload>;
  /** The controller of the signal of the provider. The subscription aborts it when it ends. */
  readonly controller: AbortController;
  /** The maximum number of occurrences that wait for the client. */
  readonly limit: number;
  /** Record a defect of the provider. */
  readonly onDefect: (cause: unknown) => void;
  /** Called one time, when the subscription ends. */
  readonly onEnd: () => void;
}

/** A subscription that runs: the iterator of the client, and the two ends that the session and the client cause. */
export interface Running<Payload> {
  readonly occurrences: Occurrences<Payload>;
  /** End the subscription as cancelled: the client sees `done: true` at once. */
  readonly cancel: () => void;
  /** End the subscription as complete: the client reads the occurrences that wait, then sees `done: true`. */
  readonly complete: () => void;
}

/** Start the pump of a subscription, and give the iterator of the client. */
export function runSubscription<Source, Payload>(parts: SubscriptionParts<Source, Payload>): Running<Payload> {
  const buffer: Occurrence<Payload>[] = [];
  const waiters: { readonly resolve: (result: IteratorResult<Occurrence<Payload>, undefined>) => void; readonly reject: (error: unknown) => void }[] = [];
  /** True when the buffer removed occurrences: the next occurrence that the client reads has `truncated: true`. */
  let dropped = false;
  /** How the source ended. The client still reads the occurrences in the buffer before it sees the end. */
  let ending: { readonly failure?: CallFailureError } | undefined;
  /** True when the client sees only `done: true`. */
  let closed = false;
  let stopped = false;
  let stopSource = () => {};

  const take = (occurrence: Occurrence<Payload>): Occurrence<Payload> => {
    if (!dropped) return occurrence;
    dropped = false;
    return { ...occurrence, truncated: true };
  };

  /** Give each waiting `next()` an occurrence or the end, while there are some. */
  const settle = () => {
    for (let waiter = waiters.shift(); waiter !== undefined; waiter = waiters.shift()) {
      const occurrence = buffer.shift();
      if (occurrence !== undefined) {
        waiter.resolve({ done: false, value: take(occurrence) });
      } else if (closed) {
        waiter.resolve(DONE);
      } else if (ending !== undefined) {
        closed = true;
        if (ending.failure === undefined) waiter.resolve(DONE);
        else waiter.reject(ending.failure);
      } else {
        waiters.unshift(waiter);
        return;
      }
    }
  };

  /** Stop the provider one time: abort its signal, and close its iterator. */
  const stop = () => {
    if (stopped) return;
    stopped = true;
    parts.controller.abort();
    stopSource();
    parts.onEnd();
  };

  const end = (how: { readonly failure?: CallFailureError }) => {
    if (stopped) return;
    ending = how;
    stop();
    settle();
  };

  const cancel = () => {
    if (closed) return;
    closed = true;
    buffer.length = 0;
    stop();
    settle();
  };

  const push = (occurrence: Occurrence<Payload>) => {
    // An occurrence that the provider marks keeps its mark. The occurrences before it in the buffer came before the gap.
    buffer.push(occurrence);
    if (buffer.length > parts.limit) {
      buffer.shift();
      dropped = true;
    }
    settle();
  };

  void (async () => {
    try {
      const iterator = parts.source[Symbol.asyncIterator]();
      // The return of an async generator waits until its body stops at a `yield`, so the subscription does not wait for it.
      stopSource = () => void Promise.resolve().then(() => iterator.return?.()).catch(() => undefined);
      if (stopped) stopSource();
      for (;;) {
        const step = await iterator.next();
        if (stopped) return;
        if (step.done === true) return end({});
        const emitted = checkEmitted(step.value);
        const data = await parts.check(emitted.data);
        if (stopped) return;
        push(occurrenceOf(parts.name, { ...emitted, data }, () => crypto.randomUUID(), () => new Date()));
      }
    } catch (cause) {
      if (stopped) return;
      parts.onDefect(cause);
      end({ failure: new CallFailureError(callFailure("internal", INTERNAL_MESSAGE)) });
    }
  })();

  const occurrences: Occurrences<Payload> = {
    next: () =>
      new Promise((resolve, reject) => {
        waiters.push({ resolve, reject });
        settle();
      }),
    return: () => {
      cancel();
      return Promise.resolve(DONE);
    },
    [Symbol.asyncIterator]: () => occurrences,
    [Symbol.asyncDispose]: () => {
      cancel();
      return Promise.resolve();
    },
  };
  return { occurrences, cancel, complete: () => end({}) };
}


/**
 * Check the members of a value that the provider gives, beside its data. The provider is code of the application, but
 * plain JavaScript can give any value. A value that is not valid is a defect.
 */
function checkEmitted<Source>(value: Emitted<Source>): Emitted<Source> {
  const object: unknown = value;
  if (typeof object !== "object" || object === null) throw new TypeError("The provider gave a value that is not an object.");
  const { eventId, timestamp, cursor, truncated } = value;
  if (eventId !== undefined && (typeof eventId !== "string" || eventId === "")) throw new TypeError("The eventId of an occurrence is not a string.");
  if (timestamp !== undefined && (typeof timestamp !== "string" || Number.isNaN(Date.parse(timestamp)))) {
    throw new TypeError("The timestamp of an occurrence is not a date and time.");
  }
  if (cursor !== undefined && typeof cursor !== "string") throw new TypeError("The cursor of an occurrence is not a string.");
  if (truncated !== undefined && truncated !== true) throw new TypeError("The truncated member of an occurrence is not true.");
  return value;
}
