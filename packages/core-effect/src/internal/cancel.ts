import { callFailure } from "@acid-cat/spec-ts";
import type { CallFailure } from "@acid-cat/spec-ts";
import { Effect } from "effect";

/**
 * Cancel a call when `signal` aborts, for example when the client closes its request. The call is interrupted, and its
 * outcome is the call failure `cancelled`.
 */
export const cancelOnAbort =
  (signal: AbortSignal) =>
  <A>(call: Effect.Effect<A>): Effect.Effect<A | CallFailure> =>
    Effect.raceFirst(call, aborted(signal));

const aborted = (signal: AbortSignal) =>
  Effect.callback<CallFailure>((resume) => {
    const cancel = () => resume(Effect.succeed(callFailure("cancelled", "The call was cancelled.")));
    if (signal.aborted) return cancel();
    signal.addEventListener("abort", cancel, { once: true });
    return Effect.sync(() => signal.removeEventListener("abort", cancel));
  });
