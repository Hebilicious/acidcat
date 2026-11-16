import { Clock, Effect, Stream } from "effect";

export const withHeartbeat = <A, E, R>(messages: Stream.Stream<A, E, R>, ms: number, beat: () => A): Stream.Stream<A, E, R> =>
  Stream.unwrap(
    Effect.gen(function* () {
      let last = yield* Clock.currentTimeMillis;
      const sent = Effect.flatMap(Clock.currentTimeMillis, (now) => Effect.sync(() => void (last = now)));
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
