import { setTimeout as pause } from "node:timers/promises";

/** The part of the context of a `node:test` test that a wait uses. */
export interface Waiter {
  readonly signal: AbortSignal;
  diagnostic(message: string): void;
}

export interface UntilOptions {
  /** The promise to wait for before the next look. By default, 2 ms. */
  readonly next?: () => Promise<unknown>;
  /** What the wait waits for, in the diagnostic. By default, the source of `done` and `look`. */
  readonly what?: string;
}

/**
 * Calls `look` until `done` accepts the value. The wait has no deadline of its own: it ends when the test ends, and then
 * writes what it waited for and the last value as a diagnostic of the test.
 */
export async function until<A, B extends A>(t: Waiter, look: () => A | Promise<A>, done: (seen: A) => seen is B, options?: UntilOptions): Promise<B>;
export async function until<A>(t: Waiter, look: () => A | Promise<A>, done?: (seen: A) => boolean, options?: UntilOptions): Promise<A>;
export async function until<A>(t: Waiter, look: () => A | Promise<A>, done: (seen: A) => boolean = Boolean, { next, what }: UntilOptions = {}): Promise<A> {
  const { signal } = t;
  const wait = next === undefined ? () => pause(2, undefined, { signal }) : () => orTestEnd(signal, next());
  let seen: A | undefined;
  // The test drops a diagnostic that comes after its end, so the listener writes it when the signal aborts.
  const report = () => t.diagnostic(`The test ended while it waited for ${what ?? condition(look, done)}. The last value was ${describe(seen)}.`);
  signal.addEventListener("abort", report, { once: true });
  try {
    seen = await look();
    while (!done(seen)) {
      await wait();
      seen = await look();
    }
    return seen;
  } finally {
    signal.removeEventListener("abort", report);
  }
}

function orTestEnd<A>(signal: AbortSignal, promise: Promise<A>): Promise<A> {
  if (signal.aborted) return Promise.reject(signal.reason);
  return new Promise<A>((resolve, reject) => {
    const end = () => reject(signal.reason);
    signal.addEventListener("abort", end, { once: true });
    promise.then(resolve, reject).finally(() => signal.removeEventListener("abort", end));
  });
}

const condition = (look: unknown, done: unknown) => (done === Boolean ? `${String(look)} to be true` : `${String(done)} on ${String(look)}`);

function describe(value: unknown): string {
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}
