import { Cause, Effect } from "effect";

import { LoadFailed } from "../Capability.ts";

/**
 * Log that a capability did not load, unless the load before it failed for the same reason: a binding that tries again
 * on each use logs each failure one time, not at each retry.
 */
export const logLoadFailure = (cause: Cause.Cause<unknown>): Effect.Effect<void> => {
  const failure = Cause.findErrorOption(cause);
  const repeated = failure._tag === "Some" && failure.value instanceof LoadFailed && failure.value.repeated;
  return repeated ? Effect.void : Effect.logError("A capability did not load", Cause.pretty(cause));
};
