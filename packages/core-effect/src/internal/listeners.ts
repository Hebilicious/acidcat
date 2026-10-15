import { Cause, Effect } from "effect";

/**
 * Give a value to each listener. A listener that throws is a defect of the listener, not of the code that calls it:
 * the error is logged, and the other listeners still get the value.
 */
export const notify = <A>(listeners: Iterable<(value: A) => void>, value: A, what: string): Effect.Effect<void> =>
  Effect.suspend(() => {
    const failures: unknown[] = [];
    for (const listener of [...listeners]) {
      try {
        listener(value);
      } catch (cause) {
        failures.push(cause);
      }
    }
    return Effect.forEach(failures, (cause) => Effect.logError(what, Cause.die(cause)), { discard: true });
  });
