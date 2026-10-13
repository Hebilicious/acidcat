/**
 * Sessions and handles (spec/invocation.md, spec/bindings/typescript.md).
 */
import { AVAILABLE, CallFailureError, callFailure, isCallFailure, viewOf } from "@acid-cat/spec";
import type { Availability, CallFailure, CatalogDocument, Outcome, Result } from "@acid-cat/spec";

import { catalogOf } from "./app.ts";
import type { AnyCapability, App, Observable, ToJsonSchema } from "./app.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

export interface Handle {
  readonly id: string;
  readonly description: string;
  readonly audience: readonly string[];
  readonly availability: Observable<Availability>;
  /** The state of the capability, if it has one. Each value is a copy. */
  readonly snapshot?: Observable<unknown>;
  /** A call with an input that is already valid. A call failure rejects with a `CallFailureError`. */
  execute(input: unknown, options?: { readonly signal?: AbortSignal | undefined }): Promise<Result<unknown, unknown>>;
  /** A call with an input that is not trusted. A call failure rejects with a `CallFailureError`. */
  invokeExternal(input: unknown, options?: { readonly signal?: AbortSignal | undefined }): Promise<Result<unknown, unknown>>;
}

export interface Session {
  readonly target: string;
  /** The view of the target. Bindings take names, descriptions and schemas from it. */
  readonly view: CatalogDocument;
  /** The handles of the capabilities in the view, by id. */
  readonly handles: ReadonlyMap<string, Handle>;
  /** A call with an input that is not trusted. The outcome is in its JSON form. The promise never rejects. */
  invoke(id: string, input: unknown, options?: { readonly signal?: AbortSignal | undefined }): Promise<Outcome<unknown, unknown>>;
  /** An event each time the availability of a capability changes. */
  onChange(listener: () => void): { unsubscribe(): void };
  /** The signal of the session. It aborts when the session closes. */
  readonly signal: AbortSignal;
  /** Close the session: accept no new calls, cancel the calls in progress, and wait for them. */
  dispose(): Promise<void>;
}

export interface SessionOptions<Context> {
  readonly target: string;
  /** The services that each `run` receives. */
  readonly context: Context;
  readonly toJsonSchema: ToJsonSchema;
  /** Record a defect. The default writes it to the console. */
  readonly onDefect?: ((id: string, cause: unknown) => void) | undefined;
}

const always: Observable<Availability> = { getSnapshot: () => AVAILABLE, subscribe: () => ({ unsubscribe() {} }) };

/** Open a session for a target. */
export function createSession<Context>(app: App<Context>, options: SessionOptions<Context>): Session {
  const view = viewOf(catalogOf(app, { toJsonSchema: options.toJsonSchema }), options.target);
  const lifetime = new AbortController();
  const running = new Set<Promise<unknown>>();
  const listeners = new Set<() => void>();
  const subscriptions: { unsubscribe(): void }[] = [];
  const onDefect = options.onDefect ?? ((id, cause) => console.error(`A capability failed with a defect: ${id}`, cause));

  const served = new Map<string, { readonly capability: AnyCapability<Context>; readonly availability: Observable<Availability> }>();
  for (const capability of app.capabilities) {
    if (!(capability.id in view.capabilities)) continue;
    const availability = capability.availability?.(options.context) ?? always;
    subscriptions.push(availability.subscribe(() => listeners.forEach((listener) => listener())));
    served.set(capability.id, { capability, availability });
  }

  /** Run a call. The result is a result or a call failure. */
  async function call(id: string, input: unknown, trusted: boolean, signal?: AbortSignal): Promise<Outcome<unknown, unknown>> {
    if (lifetime.signal.aborted || signal?.aborted) return callFailure("cancelled", "The call was cancelled.");
    const entry = served.get(id);
    if (entry === undefined) return callFailure("unknown-capability", `There is no capability ${id}.`);
    const availability = entry.availability.getSnapshot();
    if (!availability.available) return callFailure("unavailable", availability.reason);
    const { capability } = entry;

    let decoded: unknown = input ?? {};
    if (!trusted && capability.input !== undefined) {
      const validated = await (capability.input as StandardSchemaV1)["~standard"].validate(input);
      if (validated.issues !== undefined) {
        const message = validated.issues
          .map((issue) => `${(issue.path ?? []).map((key) => (typeof key === "object" ? String(key.key) : String(key))).join(".") || "input"}: ${issue.message}`)
          .join("; ");
        return callFailure("invalid-input", message);
      }
      decoded = validated.value;
    }

    const controller = new AbortController();
    const abort = () => controller.abort();
    lifetime.signal.addEventListener("abort", abort);
    signal?.addEventListener("abort", abort);
    const cancelled = new Promise<CallFailure>((resolve) =>
      controller.signal.addEventListener("abort", () => resolve(callFailure("cancelled", "The call was cancelled."))),
    );
    // The client or the session can abort during validation, before the listeners exist.
    if (lifetime.signal.aborted || signal?.aborted) controller.abort();
    const work = Promise.resolve()
      .then(() => capability.run(decoded as never, { signal: controller.signal, context: options.context }))
      .then((result) => checkResult(capability, result))
      .catch((cause: unknown) => {
        onDefect(id, cause);
        return callFailure("internal", "The capability failed.");
      });
    // The outcome settles when the work ends or when the call is cancelled, also if the work ignores the signal.
    const outcome = Promise.race([work, cancelled]);
    running.add(outcome);
    try {
      return await outcome;
    } finally {
      running.delete(outcome);
      lifetime.signal.removeEventListener("abort", abort);
      signal?.removeEventListener("abort", abort);
    }
  }

  const handles = new Map<string, Handle>();
  for (const [id, { capability, availability }] of served) {
    const reject = async (outcome: Promise<Outcome<unknown, unknown>>): Promise<Result<unknown, unknown>> => {
      const settled = await outcome;
      if (isCallFailure(settled)) throw new CallFailureError(settled);
      return settled;
    };
    const state = capability.state?.source(options.context);
    handles.set(id, {
      id,
      description: capability.description,
      audience: capability.audience,
      availability,
      ...(state === undefined ? {} : { snapshot: detached(state) }),
      execute: (input, callOptions) => reject(call(id, input, true, callOptions?.signal)),
      invokeExternal: (input, callOptions) => reject(call(id, input, false, callOptions?.signal)),
    });
  }

  return {
    target: options.target,
    view,
    handles,
    signal: lifetime.signal,
    invoke: (id, input, callOptions) => call(id, input, false, callOptions?.signal),
    onChange(listener) {
      listeners.add(listener);
      return { unsubscribe: () => listeners.delete(listener) };
    },
    async dispose() {
      lifetime.abort();
      subscriptions.forEach((subscription) => subscription.unsubscribe());
      await Promise.allSettled([...running]);
    },
  };
}

/** An observable whose values are copies, so that a client cannot change the data of the provider. */
function detached<T>(source: Observable<T>): Observable<T> {
  return {
    getSnapshot: () => structuredClone(source.getSnapshot()),
    subscribe: (listener) => source.subscribe((value) => listener(structuredClone(value))),
  };
}

/** Check a result against the output schema or the failure schemas. A result that does not agree is a defect. */
async function checkResult(capability: AnyCapability, result: Result<unknown, unknown>): Promise<Outcome<unknown, unknown>> {
  if (result.ok) {
    if (capability.output === undefined) return { ok: true, value: result.value ?? null };
    const checked = await (capability.output as StandardSchemaV1)["~standard"].validate(result.value);
    if (checked.issues !== undefined) throw new Error(`The output does not agree with its schema: ${checked.issues[0]?.message}`);
    return { ok: true, value: checked.value };
  }
  const tag = (result.error as { readonly _tag?: string })._tag;
  const schema = tag === undefined ? undefined : (capability.failures as Record<string, StandardSchemaV1> | undefined)?.[tag];
  if (schema === undefined) throw new Error(`The failure ${String(tag)} is not in failures.`);
  const checked = await schema["~standard"].validate(result.error);
  if (checked.issues !== undefined) throw new Error(`The failure ${tag} does not agree with its schema: ${checked.issues[0]?.message}`);
  return { ok: false, error: { _tag: tag, ...(checked.value as object) } };
}
