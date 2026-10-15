/**
 * The WebMCP binding (spec/bindings/webmcp.md): register capabilities as WebMCP tools in a web page.
 */
import { callFailure, CallFailureError, isCallFailure } from "@acid-cat/spec-ts";
import { Effect, Option, Queue, Scope, Stream, SubscriptionRef } from "effect";

import * as App from "./App.ts";
import type * as Capability from "./Capability.ts";
import { notify } from "./internal/listeners.ts";
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
  /**
   * The status for code that does not use Effect, with the shape of the observables of the handles. Listeners hear
   * each change at once, up to `disposed`.
   */
  readonly statusObservable: Capability.Observable<Status>;
  /** `retry` for code that does not use Effect. The status tells the outcome of the new update. */
  readonly retryPromise: () => Promise<void>;
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
    // Code that does not use Effect hears each change of the status at once, in the fiber that makes it.
    const statusListeners = new Set<(value: Status) => void>();
    // A listener that throws does not stop the installation: `notify` logs its error, and calls the other listeners.
    const setStatus = (next: Status) =>
      SubscriptionRef.set(status, next).pipe(Effect.andThen(notify(statusListeners, next, "A listener of the WebMCP status failed")));
    const lifetime = new AbortController();
    const registered = new Map<string, AbortController>();
    const calls = new Set<Promise<unknown>>();
    const requests = yield* Queue.sliding<void>(1);

    const toolFor = (id: string): ModelContextTool => {
      const capability = session.capabilities.get(id)!;
      return {
        name: id,
        description: capability.description,
        inputSchema: App.inputJsonSchema(capability),
        execute: (input, callOptions) => {
          const signal = AbortSignal.any([lifetime.signal, ...(callOptions?.signal ? [callOptions.signal] : [])]);
          const call = Effect.runPromiseWith(context)(session.invoke(id, input), { signal }).then(
            (outcome) => {
              if (isCallFailure(outcome)) throw new CallFailureError(outcome);
              return outcome;
            },
            // The signal interrupts the call. The interruption is the call failure `cancelled`.
            (error: unknown) => {
              if (signal.aborted) throw new CallFailureError(callFailure("cancelled", "The call was cancelled."));
              throw error;
            },
          );
          calls.add(call);
          void call.finally(() => calls.delete(call)).catch(() => undefined);
          return call;
        },
      };
    };

    /** One update. If it fails, the tools stay as they were before the update. */
    const pass = Effect.gen(function* () {
      const wanted = new Set<string>();
      for (const id of session.capabilities.keys()) {
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

    // Follow the changes before the first update reads the availability, so that no change between them is lost.
    yield* session.changes.pipe(Stream.runForEach(() => Queue.offer(requests, undefined)), Effect.forkIn(scope, { startImmediately: true }));

    yield* Effect.forever(
      Effect.gen(function* () {
        yield* Queue.take(requests);
        yield* setStatus({ phase: "reconciling", message: null });
        const result = yield* Effect.result(pass);
        const next: Status =
          result._tag === "Success" ? { phase: "ready", message: null } : { phase: "failed", message: result.failure };
        yield* setStatus(next);
      }),
    ).pipe(Effect.forkIn(scope));

    yield* Queue.offer(requests, undefined);

    yield* Scope.addFinalizer(
      scope,
      Effect.gen(function* () {
        yield* setStatus({ phase: "closing", message: null });
        lifetime.abort();
        registered.clear();
        yield* Effect.promise(() => Promise.allSettled([...calls]));
        yield* setStatus({ phase: "disposed", message: null });
      }),
    );

    const retry = Queue.offer(requests, undefined).pipe(Effect.asVoid);
    return Option.some<Installation>({
      status,
      retry,
      statusObservable: {
        getSnapshot: () => SubscriptionRef.getUnsafe(status),
        subscribe(listener) {
          statusListeners.add(listener);
          return { unsubscribe: () => void statusListeners.delete(listener) };
        },
      },
      retryPromise: () => Effect.runPromise(retry),
    });
  });
