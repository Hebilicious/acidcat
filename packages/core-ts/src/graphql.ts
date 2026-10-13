/**
 * The GraphQL binding (spec/bindings/graphql.md). The schema and the execution come from `@acid-cat/graphql`.
 */
import { executable, execute, readRequest, respond } from "@acid-cat/graphql";
import { viewOf } from "@acid-cat/spec";

import { catalogOf } from "./app.ts";
import type { App, ToJsonSchema } from "./app.ts";
import { createSession } from "./session.ts";

export interface GraphqlOptions<Context> {
  /** The origins that can call the API. A request with no `Origin` header is accepted. */
  readonly allowedOrigins: readonly string[];
  readonly context: Context;
  readonly toJsonSchema: ToJsonSchema;
  /** The target that the API serves. The default is `"graphql"`. */
  readonly target?: string | undefined;
  /** The maximum size of a request body, in bytes. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
}

/** A web request handler for the GraphQL API. Each request has its own session. */
export function graphqlHandler<Context>(app: App<Context>, options: GraphqlOptions<Context>) {
  const target = options.target ?? "graphql";
  const schema = executable(viewOf(catalogOf(app, { toJsonSchema: options.toJsonSchema }), target));
  return async (request: Request): Promise<Response> => {
    const parsed = await readRequest(request, options);
    if (parsed instanceof Response) return parsed;
    const session = createSession(app, { target, context: options.context, toJsonSchema: options.toJsonSchema });
    try {
      const result = await execute(
        schema,
        {
          view: session.view,
          availability: async (id) => session.handles.get(id)!.availability.getSnapshot(),
          invoke: (id, input, signal) => session.invoke(id, input, { signal }),
        },
        parsed,
        request.signal,
      );
      return respond(result);
    } finally {
      await session.dispose();
    }
  };
}
