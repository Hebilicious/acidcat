import { SSE_MEDIA_TYPE } from "@acid-cat/spec-ts";
import { Cause, Effect, Exit, Layer, ManagedRuntime, Scope } from "effect";

import { headOf, IncomingRequest, Refusal, refusalResponse } from "../Remote.ts";

/**
 * Keep the services of a request open until `holder` closes, also after the response is complete. A poll lease and a
 * webhook subscription keep the services of the request that started them.
 */
export type Keep = (holder: Scope.Scope) => Effect.Effect<void>;

/** Keep nothing: the services are shared, or the host keeps them. */
export const keepNothing: Keep = () => Effect.void;

/**
 * Run the answers of a web handler with the services of `layer`. With `"per-request"`, each answer builds the services
 * in its own scope. If not, all answers share the services, built one time for the first answer. The answer gets the
 * scope of its request, and closes it: when the response is ready, or when the stream of its body ends. With
 * `"per-request"`, the services stay open until the scope of the request and each scope that `keep` got are closed.
 * `dispose` releases the shared services.
 *
 * With `"per-request"`, the layer reads the head of the request from `IncomingRequest`. When the layer fails with a
 * `Refusal`, the answer is the refusal, and `answer` does not run. The shared services have no request: the public
 * handlers accept a layer that needs `IncomingRequest` only with `"per-request"`, so the shared layer never reads it.
 */
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

/** The head of the request of the shared services, which have no request. No typed layer reads it. */
const noRequest = { method: "", url: "", headers: new Headers() };

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
