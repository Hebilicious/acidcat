import { SSE_MEDIA_TYPE } from "@acid-cat/spec-ts";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";

import { headOf, IncomingRequest, Refusal, refusalResponse } from "../Remote.ts";

export type Keep = (holder: Scope.Scope) => Effect.Effect<void>;

export const keepNothing: Keep = () => Effect.void;

export function answerWith<R, E>(layer: Layer.Layer<R, E, IncomingRequest>, services: "shared" | "per-request" | undefined) {
  const runtime = services === "per-request" ? undefined : ManagedRuntime.make(Layer.provide(layer, Layer.succeed(IncomingRequest, noRequest)));
  const answer = async <AE>(request: Request, answer: (scope: Scope.Closeable, keep: Keep) => Effect.Effect<Response, AE, R>): Promise<Response> => {
    const scope = Effect.runSync(Scope.make());
    if (runtime !== undefined) return runtime.runPromise(answer(scope, keepNothing));
    const servicesScope = Effect.runSync(Scope.make());
    const built = await Effect.runPromiseExit(Layer.buildWithScope(layer, servicesScope).pipe(Effect.provideService(IncomingRequest, headOf(request))));
    if (Exit.isFailure(built)) {
      await Effect.runPromise(Scope.close(servicesScope, built));
      await Effect.runPromise(Scope.close(scope, built));
      const failure = Cause.findErrorOption(built.cause);
      if (failure._tag === "Some" && failure.value instanceof Refusal) return refusalResponse(failure.value);
      return Effect.runPromise(Effect.failCause(built.cause));
    }
    let holders = 1;
    const release = Effect.suspend(() => {
      holders -= 1;
      return holders === 0 ? Scope.close(servicesScope, Exit.void) : Effect.void;
    });
    Effect.runSync(Scope.addFinalizer(scope, release));
    const keep: Keep = (holder) =>
      Effect.suspend(() => {
        holders += 1;
        return Scope.addFinalizer(holder, release);
      });
    return Effect.runPromise(Effect.provideContext(answer(scope, keep), built.value));
  };
  const dispose = async (): Promise<void> => {
    if (runtime !== undefined) await runtime.dispose();
  };
  return { answer, dispose };
}

const noRequest = { method: "", url: "", headers: new Headers() };

export interface Streaming {
  readonly streaming: Response;
}

export const closeUnlessStreaming =
  (scope: Scope.Closeable) =>
  <E, R>(answer: Effect.Effect<Response | Streaming, E, R>): Effect.Effect<Response, E, R> =>
    answer.pipe(
      Effect.onExit((exit) => (Exit.isSuccess(exit) && "streaming" in exit.value ? Effect.void : Scope.close(scope, Exit.void))),
      Effect.map((each) => ("streaming" in each ? each.streaming : each)),
    );

export function eventStream(body: ReadableStream<Uint8Array>, request: Request, scope: Scope.Closeable): Streaming {
  request.signal.addEventListener("abort", () => Effect.runFork(Scope.close(scope, Exit.void)), { once: true });
  return { streaming: new Response(body, { status: 200, headers: { "Content-Type": SSE_MEDIA_TYPE, "Cache-Control": "no-store" } }) };
}
