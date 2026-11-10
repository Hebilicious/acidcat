import { SSE_MEDIA_TYPE } from "@acid-cat/spec-ts";
import { Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";

/**
 * Run the answers of a web handler with the services of `layer`. With `"per-request"`, each answer builds the services
 * in its own scope. If not, all answers share the services, built one time for the first answer. The answer gets the
 * scope of its request, and closes it: when the response is ready, or when the stream of its body ends.
 */
export function answerWith<R, E>(layer: Layer.Layer<R, E>, services: "shared" | "per-request" | undefined) {
  const runtime = services === "per-request" ? undefined : ManagedRuntime.make(layer);
  return async <AE>(answer: (scope: Scope.Closeable) => Effect.Effect<Response, AE, R>): Promise<Response> => {
    const scope = Effect.runSync(Scope.make());
    if (runtime !== undefined) return runtime.runPromise(answer(scope));
    const built = await Effect.runPromiseExit(Layer.buildWithScope(layer, scope));
    if (Exit.isFailure(built)) {
      await Effect.runPromise(Scope.close(scope, built));
      return Effect.runPromise(Effect.failCause(built.cause));
    }
    return Effect.runPromise(Effect.provideContext(answer(scope), built.value));
  };
}

/** A response whose body is a stream. The stream closes the scope of its request when it ends. */
export interface Streaming {
  readonly streaming: Response;
}

/**
 * The response of an answer. The scope of the request closes when the answer ends, but not when the answer is a
 * stream: the stream closes it.
 */
export const closeUnlessStreaming =
  (scope: Scope.Closeable) =>
  <E, R>(answer: Effect.Effect<Response | Streaming, E, R>): Effect.Effect<Response, E, R> =>
    answer.pipe(
      Effect.onExit((exit) => (Exit.isSuccess(exit) && "streaming" in exit.value ? Effect.void : Scope.close(scope, Exit.void))),
      Effect.map((each) => ("streaming" in each ? each.streaming : each)),
    );

/**
 * A response with a stream of server-sent events. The client closing the request closes `scope`, also if the body was
 * never read.
 */
export function eventStream(body: ReadableStream<Uint8Array>, request: Request, scope: Scope.Closeable): Streaming {
  request.signal.addEventListener("abort", () => Effect.runFork(Scope.close(scope, Exit.void)), { once: true });
  return { streaming: new Response(body, { status: 200, headers: { "Content-Type": SSE_MEDIA_TYPE, "Cache-Control": "no-store" } }) };
}
