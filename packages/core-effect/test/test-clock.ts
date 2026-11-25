import { Clock, Effect, Exit, Layer, Scope } from "effect";
import type { Duration } from "effect";
import { TestClock } from "effect/testing";

/**
 * A `TestClock` for a server that the test builds outside an Effect, such as `Mcp.toWebHandler`. Give `layer` with the
 * services of the server: each answer, and each poll lease and webhook subscription that an answer starts, use the clock.
 * The clock moves only when the test calls `adjust`, and a sleep of 0 ends at once.
 */
export function testClock() {
  const scope = Effect.runSync(Scope.make());
  const clock = Effect.runSync(TestClock.make().pipe(Scope.provide(scope)));
  return {
    layer: Layer.succeed(Clock.Clock, clock),
    adjust: (duration: Duration.Input) => Effect.runPromise(clock.adjust(duration)),
    close: () => Effect.runPromise(Scope.close(scope, Exit.void)),
  };
}
