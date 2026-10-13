/**
 * The GraphQL binding (spec/bindings/graphql.md), for any provider that can list and invoke capabilities.
 * Both AcidCat cores use it. It depends on graphql-js and has no other runtime dependency.
 */
import { isCallFailure, readBounded, screenRequest } from "@acid-cat/spec";
import type { Availability, CatalogDocument, Outcome, Rejection } from "@acid-cat/spec";
import { buildSchema, graphql, GraphQLError } from "graphql";
import type { ExecutionResult, GraphQLSchema } from "graphql";

import { graphqlSchema } from "./schema.ts";
import type { Operation } from "./schema.ts";

export { graphqlSchema } from "./schema.ts";
export type { GraphqlSchema, Operation } from "./schema.ts";

/** What the binding needs from a session. */
export interface Provider {
  readonly view: CatalogDocument;
  availability(id: string): Promise<Availability>;
  invoke(id: string, input: unknown, signal: AbortSignal): Promise<Outcome<unknown, unknown>>;
}

/** An executable GraphQL schema for a view. Make it one time, and use it for each request. */
export interface Executable {
  readonly schema: GraphQLSchema;
  readonly operations: ReadonlyMap<string, Operation>;
}

export function executable(view: CatalogDocument): Executable {
  const { sdl, operations } = graphqlSchema(view);
  return { schema: buildSchema(sdl), operations };
}

export interface GraphqlRequest {
  readonly query: string;
  readonly variables?: Record<string, unknown> | undefined;
  readonly operationName?: string | undefined;
}

/** Run one GraphQL request against a provider. */
export function execute(target: Executable, provider: Provider, request: GraphqlRequest, signal: AbortSignal): Promise<ExecutionResult> {
  const rootValue: Record<string, unknown> = {
    acidcatCapabilities: () =>
      Promise.all(Object.keys(provider.view.capabilities).map(async (id) => ({ id, ...(await provider.availability(id)) }))),
    acidcatCatalog: () => provider.view,
    acidcatInvoke: async ({ id, input }: { id: string; input?: unknown }) => {
      const outcome = await provider.invoke(id, input ?? {}, signal);
      return isCallFailure(outcome) ? { kind: outcome.kind, message: outcome.message } : outcome;
    },
  };
  for (const operation of target.operations.values()) {
    rootValue[operation.field] = async ({ input }: { input?: unknown }) => {
      const outcome = await provider.invoke(operation.id, input ?? {}, signal);
      if (isCallFailure(outcome)) throw new GraphQLError(outcome.message, { extensions: { kind: outcome.kind } });
      if (outcome.ok) {
        return operation.wrapped
          ? { __typename: operation.valueType, value: outcome.value }
          : { __typename: operation.valueType, ...(outcome.value as object) };
      }
      const failure = outcome.error as { readonly _tag: string };
      return { __typename: operation.failureTypes[failure._tag], ...failure };
    };
  }
  return Promise.resolve(
    graphql({
      schema: target.schema,
      source: request.query,
      rootValue,
      variableValues: request.variables ?? null,
      operationName: request.operationName ?? null,
    }),
  );
}

export interface HttpOptions {
  /** The origins that can call the API. A request with no `Origin` header is accepted. */
  readonly allowedOrigins: readonly string[];
  /** The maximum size of a request body, in bytes. The default is 1 MiB. */
  readonly maximumBytes?: number | undefined;
}

/** Read a GraphQL request from HTTP. A rejected request gives a response instead. */
export async function readRequest(request: Request, options: HttpOptions): Promise<GraphqlRequest | Response> {
  const maximumBytes = options.maximumBytes ?? 1_048_576;
  const screened = screenRequest(request, { methods: ["POST"], allowedOrigins: options.allowedOrigins, mediaType: "application/json", maximumBytes });
  if (screened !== undefined) return rejection(screened);
  const body = await readBounded(request, maximumBytes);
  if ("rejection" in body) return rejection(body.rejection);
  try {
    const parsed = JSON.parse(body.text) as GraphqlRequest;
    if (typeof parsed?.query !== "string") return Response.json({ errors: [{ message: "The body has no query." }] }, { status: 400 });
    return parsed;
  } catch {
    return rejection("not-utf8");
  }
}

/** The HTTP response for a GraphQL result. */
export const respond = (result: ExecutionResult): Response => Response.json(result, { status: 200 });

const statuses: { readonly [R in Rejection]: number } = {
  method: 405,
  origin: 403,
  "media-type": 415,
  "too-large": 413,
  "not-utf8": 400,
};

function rejection(reason: Rejection): Response {
  const headers = new Headers({ "Cache-Control": "no-store" });
  if (reason === "method") headers.set("Allow", "POST");
  return new Response(null, { status: statuses[reason], headers });
}
