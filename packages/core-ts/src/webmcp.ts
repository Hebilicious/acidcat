/**
 * The WebMCP binding (spec/bindings/webmcp.md): register capabilities as WebMCP tools in a web page.
 */
import { bundle, CallFailureError, isCallFailure } from "@acid-cat/spec-ts";

import type { Observable } from "./app.ts";
import type { Session } from "./session.ts";

export interface ModelContextTool {
  readonly name: string;
  readonly description: string;
  readonly inputSchema: object;
  readonly execute: (input: unknown, options?: { readonly signal?: AbortSignal }) => Promise<unknown>;
}

export interface ModelContext {
  readonly registerTool: (tool: ModelContextTool, options: { readonly signal: AbortSignal }) => unknown;
}

export type Phase = "loading" | "reconciling" | "ready" | "failed" | "closing" | "disposed";

export interface Status {
  readonly phase: Phase;
  readonly message: string | null;
}

export interface Installation {
  readonly status: Observable<Status>;
  /** Try the last failed update again. */
  retry(): void;
  /** Remove all tools, and wait for the calls in progress. */
  dispose(): Promise<void>;
}

/** The WebMCP host of the page, if there is one (spec/bindings/webmcp.md#host). */
export function findHost(): ModelContext | undefined {
  const scope = globalThis as { document?: { modelContext?: unknown }; navigator?: { modelContext?: unknown } };
  for (const candidate of [scope.document?.modelContext, scope.navigator?.modelContext]) {
    if (typeof (candidate as ModelContext | undefined)?.registerTool === "function") return candidate as ModelContext;
  }
  return undefined;
}

/** Register the capabilities of a session as tools. If there is no host, do nothing and return `undefined`. */
export function installWebMcp(session: Session, options: { readonly host?: ModelContext | undefined } = {}): Installation | undefined {
  const host = options.host ?? findHost();
  if (host === undefined) return undefined;

  let status: Status = { phase: "loading", message: null };
  const listeners = new Set<(value: Status) => void>();
  const setStatus = (next: Status) => {
    status = next;
    listeners.forEach((listener) => listener(next));
  };

  const lifetime = new AbortController();
  const registered = new Map<string, AbortController>();
  const calls = new Set<Promise<unknown>>();
  const types = session.view.$defs ?? {};
  let running = false;
  let dirty = false;

  const toolFor = (id: string): ModelContextTool => {
    const capability = session.view.capabilities[id]!;
    return {
      name: id,
      description: capability.description,
      inputSchema: bundle(capability.input ?? { type: "object" }, types),
      execute: (input, callOptions) => {
        const signal = AbortSignal.any([lifetime.signal, ...(callOptions?.signal ? [callOptions.signal] : [])]);
        const call = session.invoke(id, input, { signal }).then((outcome) => {
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
  async function pass(): Promise<void> {
    const wanted = new Set([...session.handles.values()].filter((handle) => handle.availability.getSnapshot().available).map((handle) => handle.id));
    const added = new Map<string, AbortController>();
    try {
      for (const id of wanted) {
        if (registered.has(id)) continue;
        const controller = new AbortController();
        added.set(id, controller);
        await host!.registerTool(toolFor(id), { signal: AbortSignal.any([controller.signal, lifetime.signal]) });
      }
    } catch (error) {
      for (const controller of added.values()) controller.abort();
      throw error;
    }
    for (const [id, controller] of added) registered.set(id, controller);
    for (const [id, controller] of registered) {
      if (!wanted.has(id)) {
        controller.abort();
        registered.delete(id);
      }
    }
  }

  /** Run updates one at a time. A request during an update causes one more update. */
  async function reconcile(): Promise<void> {
    if (lifetime.signal.aborted) return;
    if (running) {
      dirty = true;
      return;
    }
    running = true;
    try {
      do {
        dirty = false;
        setStatus({ phase: "reconciling", message: null });
        try {
          await pass();
          setStatus({ phase: "ready", message: null });
        } catch (error) {
          setStatus({ phase: "failed", message: error instanceof Error ? error.message : "A tool could not be registered." });
          dirty = false;
        }
      } while (dirty && !lifetime.signal.aborted);
    } finally {
      running = false;
    }
  }

  const subscription = session.onChange(() => void reconcile());
  void reconcile();

  return {
    status: {
      getSnapshot: () => status,
      subscribe(listener) {
        listeners.add(listener);
        return { unsubscribe: () => listeners.delete(listener) };
      },
    },
    retry: () => void reconcile(),
    async dispose() {
      setStatus({ phase: "closing", message: null });
      subscription.unsubscribe();
      lifetime.abort();
      registered.clear();
      await Promise.allSettled([...calls]);
      setStatus({ phase: "disposed", message: null });
    },
  };
}
