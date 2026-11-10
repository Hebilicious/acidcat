import { Clock, Effect, Stream } from "effect";

/**
 * The messages of a stream, with the message of `beat` each time that the stream gives no message for `ms`
 * milliseconds: a keepalive or a heartbeat. The result ends when the stream ends.
 */
export const withHeartbeat = <A, E, R>(messages: Stream.Stream<A, E, R>, ms: number, beat: () => A): Stream.Stream<A, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      let last = yield* Clock.currentTimeMillis;
      const sent = Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sync(() => void (last = now)));
      /** Wait until the stream gave no message for `ms`, then give the message of `beat`. */
      const nextBeat: Effect.Effect<A> = Effect.gen(function* () {
        for (;;) {
          const now = yield* Clock.currentTimeMillis;
          const wait = last + ms - now;
          if (wait <= 0) {
            last = now;
            return beat();
          }
          yield* Effect.sleep(wait);
        }
      });
      return Stream.merge(Stream.tap(messages, () => sent), Stream.fromEffectRepeat(nextBeat), { haltStrategy: "left" });
    }),
  );
