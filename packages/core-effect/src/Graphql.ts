/**
 * The GraphQL binding (spec/bindings/graphql.md). The schema and the execution come from `@acid-cat/graphql`.
 */
import { executable, execute, readRequest, respond } from "@acid-cat/graphql";
import type { GraphqlRequest } from "@acid-cat/graphql";
import { viewOf } from "@acid-cat/spec";
import { Effect, Layer, ManagedRuntime } from "effect";

import * as App from "./App.ts";
import * as Session from "./Session.ts";

export interface Options {
  /** The origins that can call the API. A request with no `Origin` header is accepted. */
  readonly allowedOrigins: readonly string[];
  /** The target that the API serves. The default is `"graphql"`. */
  readonly target?: string | undefined;
  /** The maximum size of a request body, in bytes. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
}

/** A web request handler for the GraphQL API. Each request has its own session. */
export function toWebHandler<R, E>(app: App.App<R>, layer: Layer.Layer<R, E>, options: Options) {
  const runtime = ManagedRuntime.make(layer);
  const target = options.target ?? "graphql";
  const schema = executable(viewOf(App.document(app), target));
  return async (request: Request): Promise<Response> => {
    const parsed = await readRequest(request, options);
    if (parsed instanceof Response) return parsed;
    return runtime.runPromise(handle(app, schema, parsed, target, request.signal));
  };
}

/** Answer one GraphQL request with a new session. */
export const handle = <R>(
  app: App.App<R>,
  schema: ReturnType<typeof executable>,
  request: GraphqlRequest,
  target: string,
  signal: AbortSignal,
): Effect.Effect<Response, never, R> =>
  Effect.scoped(
    Effect.gen(function* () {
      const session = yield* Session.make(app, { target });
      const run = Effect.runPromiseWith(yield* Effect.context<never>());
      const result = yield* Effect.promise(() =>
        execute(
          schema,
          {
            view: session.view,
            availability: (id) => run(session.availability(id)),
            invoke: (id, input, callSignal) => run(session.invoke(id, input), { signal: callSignal }),
          },
          request,
          signal,
        ),
      );
      return respond(result);
    }),
  );
