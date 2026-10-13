/**
 * The WebMCP binding (spec/bindings/webmcp.md): register capabilities as WebMCP tools in a web page.
 */
import { bundle, CallFailureError, isCallFailure } from "@acid-cat/spec";
import { Effect, Option, Queue, Scope, Stream, SubscriptionRef } from "effect";

import type * as Session from "./Session.ts";

/** A WebMCP tool, as `registerTool` receives it. */
export interface ModelContextTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly execute: (input: unknown, options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
}

/** The part of the WebMCP host that the binding uses. */
export interface ModelContext {
  readonly registerTool: (tool: ModelContextTool, options: { readonly signal: AbortSignal }) => unknown;
}

export type Phase = "loading" | "reconciling" | "ready" | "failed" | "closing" | "disposed";

export interface Status {
  readonly phase: Phase;
  readonly message: string | null;
}

export interface Installation {
  readonly status: SubscriptionRef.SubscriptionRef<Status>;
  /** Try the last failed update again. */
  readonly retry: Effect.Effect<void>;
}

/** The WebMCP host of the page, if there is one (spec/bindings/webmcp.md#host). */
export function findHost(): ModelContext | undefined {
  const scope = globalThis as { document?: { modelContext?: unknown }; navigator?: { modelContext?: unknown } };
  for (const candidate of [scope.document?.modelContext, scope.navigator?.modelContext]) {
    if (typeof (candidate as ModelContext | undefined)?.registerTool === "function") return candidate as ModelContext;
  }
  return undefined;
}

/**
 * Register the capabilities of a session as tools. If there is no host, do nothing and return `None`. The tools are
 * removed when the scope closes.
 */
export const install = (session: Session.Session, options: { readonly host?: ModelContext | undefined } = {}) =>
  Effect.gen(function* () {
    const host = options.host ?? findHost();
    if (host === undefined) return Option.none<Installation>();

    const scope = yield* Effect.scope;
    const context = yield* Effect.context<never>();
    const status = yield* SubscriptionRef.make<Status>({ phase: "loading", message: null });
    const lifetime = new AbortController();
    const registered = new Map<string, AbortController>();
    const calls = new Set<Promise<unknown>>();
    const requests = yield* Queue.sliding<void>(1);
    const types = session.view.$defs ?? {};

    const toolFor = (id: string): ModelContextTool => {
      const capability = session.view.capabilities[id]!;
      return {
        name: id,
        description: capability.description,
        inputSchema: bundle(capability.input ?? { type: "object" }, types),
        execute: (input, callOptions) => {
          const call = Effect.runPromiseWith(context)(session.invoke(id, input), {
            signal: AbortSignal.any([lifetime.signal, ...(callOptions?.signal ? [callOptions.signal] : [])]),
          }).then((outcome) => {
            if (isCallFailure(outcome)) throw new CallFailureError(outcome);
            return outcome;
          });
          calls.add(call);
          void call.finally(() => calls.delete(call)).catch(() => undefined);
          return call;
        },
      };
    };

    /** One update. If it fails, the tools stay as they were before the update. */
    const pass = Effect.gen(function* () {
      const wanted = new Set<string>();
      for (const id of Object.keys(session.view.capabilities)) {
        if ((yield* session.availability(id)).available) wanted.add(id);
      }
      const added = new Map<string, AbortController>();
      const registrations = [...wanted].filter((id) => !registered.has(id));
      const result = yield* Effect.tryPromise(async () => {
        for (const id of registrations) {
          const controller = new AbortController();
          added.set(id, controller);
          await host.registerTool(toolFor(id), { signal: AbortSignal.any([controller.signal, lifetime.signal]) });
        }
      }).pipe(Effect.result);
      if (result._tag === "Failure") {
        for (const controller of added.values()) controller.abort();
        const cause = result.failure.cause;
        return yield* Effect.fail(cause instanceof Error ? cause.message : "A tool could not be registered.");
      }
      for (const [id, controller] of added) registered.set(id, controller);
      for (const [id, controller] of registered) {
        if (!wanted.has(id)) {
          controller.abort();
          registered.delete(id);
        }
      }
    });

    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(requests);
        yield* SubscriptionRef.set(status, { phase: "reconciling", message: null });
        const result = yield* Effect.result(pass);
        const next: Status =
          result._tag === "Success" ? { phase: "ready", message: null } : { phase: "failed", message: result.failure };
        yield* SubscriptionRef.set(status, next);
      }),
    ).pipe(Effect.forkIn(scope));

    yield* session.changes.pipe(Stream.runForEach(() => Queue.offer(requests, undefined)), Effect.forkIn(scope));
    yield* Queue.offer(requests, undefined);

    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        yield* SubscriptionRef.set(status, { phase: "closing", message: null });
        lifetime.abort();
        registered.clear();
        yield* Effect.promise(() => Promise.allSettled([...calls]));
        yield* SubscriptionRef.set(status, { phase: "disposed", message: null });
      }),
    );

    return Option.some<Installation>({ status, retry: Queue.offer(requests, undefined).pipe(Effect.asVoid) });
  });
