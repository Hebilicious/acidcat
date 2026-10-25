/**
 * Sessions and handles (spec/invocation.md, spec/bindings/typescript.md).
 */
import { AVAILABLE, CallFailureError, callFailure, isCallFailure, viewOf } from "@acid-cat/spec-ts";
import type { Availability, CallFailure, CatalogDocument, Outcome, Result } from "@acid-cat/spec-ts";

import { catalogOf } from "./app.ts";
import type { AnyCapability, App, Call, Capability, FailureOf, FailureSchemas, Observable, ToJsonSchema } from "./app.ts";
import type { StandardSchemaV1 } from "./standard-schema.ts";

/**
 * The handle of a capability (spec/bindings/typescript.md#handles). `Input`, `Value`, `Failure` and `State` are the
 * types of the schemas of the capability. `getHandle` gives a handle with these types. A handle of `session.handles`
 * has the input type `never`: only `invokeExternal` can call it, because it decodes the input.
 */
export interface Handle<Input = never, Value = unknown, Failure = unknown, State = unknown> {
  readonly id: string;
  readonly description: string;
  readonly audience: readonly string[];
  readonly availability: Observable<Availability>;
  /** The state of the capability, if it has one. Each value is a copy. */
  readonly snapshot?: Observable<State>;
  /** A call with an input that is already valid. A call failure rejects with a `CallFailureError`. */
  execute(input: Input, options?: { readonly signal?: AbortSignal | undefined }): Promise<Result<Value, Failure>>;
  /** A call with an input that is not trusted. A call failure rejects with a `CallFailureError`. */
  invokeExternal(input: unknown, options?: { readonly signal?: AbortSignal | undefined }): Promise<Result<unknown, unknown>>;
}

/** The handle of a capability, with the types of its schemas. `getHandle` gives it. */
export type HandleOf<C> =
  C extends Capability<never, infer Input, infer Value, infer Failures, infer State, string> ? Handle<Input, Value, FailureOf<Failures>, State> : never;

/** The handles of a session, by id, for the capabilities in its view. */
export interface Handles<Context> extends ReadonlyMap<string, Handle> {
  /**
   * The handle of a capability, with the types of the capability. `getHandle` calls it. Only the capability object
   * that the session serves gets a handle that calls it. Any other capability gets a handle that is always unavailable.
   */
  readonly handleOf: <Input, Value, Failures, State, Id extends string>(
    capability: Capability<Context, Input, Value, Failures, State, Id>,
  ) => Handle<Input, Value, FailureOf<Failures>, State>;
}

/**
 * The handle of a capability, with the types of the capability. For a capability outside the view, the handle is
 * always unavailable, and each call rejects as `unknown-capability`.
 */
export function getHandle<Context, Input, Value, Failures, State, Id extends string>(
  handles: Handles<Context>,
  capability: Capability<Context, Input, Value, Failures, State, Id>,
): Handle<Input, Value, FailureOf<Failures>, State> {
  return handles.handleOf(capability);
}

/** The handle of a capability that the session does not serve. */
function outsideView<Input, Value, Failure, State>(capability: { readonly id: string; readonly description: string }): Handle<Input, Value, Failure, State> {
  const failure = callFailure("unknown-capability", `There is no capability ${capability.id}.`);
  const unavailable: Availability = { available: false, reason: failure.message };
  const reject = () => Promise.reject(new CallFailureError(failure));
  return {
    id: capability.id,
    description: capability.description,
    audience: [],
    availability: { getSnapshot: () => unavailable, subscribe: () => ({ unsubscribe() {} }) },
    execute: reject,
    invokeExternal: reject,
  };
}

export interface Session<Context = unknown> {
  readonly target: string;
  /**
   * The view of the target. Bindings take names, descriptions and schemas from it. The session writes the view when it
   * is first read.
   */
  readonly view: CatalogDocument;
  /** The handles of the capabilities in the view, by id. */
  readonly handles: Handles<Context>;
  /** A call with an input that is not trusted. The outcome is in its JSON form. The promise never rejects. */
  invoke(id: string, input: unknown, options?: { readonly signal?: AbortSignal | undefined }): Promise<Outcome<unknown, unknown>>;
  /**
   * An event each time the availability of a capability changes. The session subscribes to the availabilities when the
   * first listener subscribes, and unsubscribes after the last listener unsubscribes.
   */
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

/** A capability that the session serves, and its availability. */
interface Served<Context> {
  readonly capability: AnyCapability<Context>;
  readonly availability: Observable<Availability>;
}

/** The input of a call, decoded: the issues, or the start of the work, which gives the checked result. */
type Prepared<Context, T> = { readonly issues: readonly StandardSchemaV1.Issue[] } | { readonly start: (call: Call<Context>) => Promise<T> };

/** The handles of a session: a map by id, and `handleOf`. */
class SessionHandles<Context> extends Map<string, Handle> implements Handles<Context> {
  readonly handleOf: Handles<Context>["handleOf"];

  constructor(handleOf: Handles<Context>["handleOf"]) {
    super();
    this.handleOf = handleOf;
  }
}

const always: Observable<Availability> = { getSnapshot: () => AVAILABLE, subscribe: () => ({ unsubscribe() {} }) };

/** Open a session for a target. */
export function createSession<Context>(app: App<Context>, options: SessionOptions<Context>): Session<Context> {
  const lifetime = new AbortController();
  const running = new Set<Promise<unknown>>();
  const listeners = new Set<() => void>();
  let subscriptions: { unsubscribe(): void }[] = [];
  const onDefect = options.onDefect ?? ((id, cause) => console.error(`A capability failed with a defect: ${id}`, cause));

  const served = new Map<string, Served<Context>>();
  for (const capability of app.capabilities) {
    if (!capability.audience.includes(options.target)) continue;
    if (served.has(capability.id)) throw new Error(`The capability ${capability.id} is declared two times.`);
    const availability = capability.availability?.(options.context) ?? always;
    served.set(capability.id, { capability, availability });
  }

  /**
   * Run a call of a capability that the session serves: availability, then the decoded input, then the work, with
   * cancellation. A defect is the call failure `internal`.
   */
  async function perform<T>(id: string, entry: Served<Context>, prepare: () => Promise<Prepared<Context, T>>, signal?: AbortSignal): Promise<T | CallFailure> {
    if (lifetime.signal.aborted || signal?.aborted) return callFailure("cancelled", "The call was cancelled.");
    const availability = entry.availability.getSnapshot();
    if (!availability.available) return callFailure("unavailable", availability.reason);
    const prepared = await prepare();
    if ("issues" in prepared) return callFailure("invalid-input", issueMessage(prepared.issues));

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
      .then(() => prepared.start({ signal: controller.signal, context: options.context }))
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

  /** A call with an input that is not trusted. The outcome is a result or a call failure. */
  async function invoke(id: string, input: unknown, signal?: AbortSignal): Promise<Outcome<unknown, unknown>> {
    if (lifetime.signal.aborted || signal?.aborted) return callFailure("cancelled", "The call was cancelled.");
    const entry = served.get(id);
    if (entry === undefined) return callFailure("unknown-capability", `There is no capability ${id}.`);
    const { capability } = entry;
    return perform(id, entry, async () => {
      const decoded = await capability.decode(input);
      if ("issues" in decoded) return decoded;
      return { start: async (call) => checkResult(capability, await decoded.start(call)) };
    }, signal);
  }

  /** Reject a call failure, as a handle does. */
  const settle = async <T>(outcome: Promise<Result<T, unknown> | CallFailure>): Promise<Result<T, unknown>> => {
    const settled = await outcome;
    if (isCallFailure(settled)) throw new CallFailureError(settled);
    return settled;
  };

  /** The typed handle of a capability that the session serves, or the handle outside the view. */
  function handleOf<Input, Value, Failures, State, Id extends string>(
    capability: Capability<Context, Input, Value, Failures, State, Id>,
  ): Handle<Input, Value, FailureOf<Failures>, State> {
    const entry = served.get(capability.id);
    if (entry === undefined || entry.capability !== capability) return outsideView(capability);
    const state = capability.state?.source(options.context);
    const run = (input: Input, call: Call<Context>) => (capability.input === undefined ? capability.run({}, call) : capability.run(input, call));
    return {
      id: capability.id,
      description: capability.description,
      audience: [options.target],
      availability: entry.availability,
      ...(state === undefined ? {} : { snapshot: detached(state) }),
      execute: async (input, callOptions) => {
        const outcome = await perform(capability.id, entry, () => Promise.resolve({ start: async (call: Call<Context>) => checkTyped(capability, await run(input, call)) }), callOptions?.signal);
        if (isCallFailure(outcome)) throw new CallFailureError(outcome);
        return outcome;
      },
      invokeExternal: (input, callOptions) => settle(invoke(capability.id, input, callOptions?.signal)),
    };
  }

  const handles = new SessionHandles<Context>(handleOf);
  for (const [id, { capability, availability }] of served) {
    const invokeExternal = (input: unknown, callOptions?: { readonly signal?: AbortSignal | undefined }) => settle(invoke(id, input, callOptions?.signal));
    const state = capability.state?.source(options.context);
    handles.set(id, {
      id,
      description: capability.description,
      audience: [options.target],
      availability,
      ...(state === undefined ? {} : { snapshot: detached(state) }),
      execute: invokeExternal,
      invokeExternal,
    });
  }

  const unsubscribeAll = () => {
    subscriptions.forEach((subscription) => subscription.unsubscribe());
    subscriptions = [];
  };

  let view: CatalogDocument | undefined;

  return {
    target: options.target,
    get view() {
      return (view ??= viewOf(catalogOf(app, { toJsonSchema: options.toJsonSchema }), options.target));
    },
    handles,
    signal: lifetime.signal,
    invoke: (id, input, callOptions) => invoke(id, input, callOptions?.signal),
    onChange(listener) {
      if (lifetime.signal.aborted) return { unsubscribe() {} };
      if (listeners.size === 0) {
        const announce = () => listeners.forEach((each) => each());
        subscriptions = [...served.values()].map(({ availability }) => availability.subscribe(announce));
      }
      listeners.add(listener);
      return {
        unsubscribe() {
          if (listeners.delete(listener) && listeners.size === 0) unsubscribeAll();
        },
      };
    },
    async dispose() {
      lifetime.abort();
      listeners.clear();
      unsubscribeAll();
      await Promise.allSettled(running);
    },
  };
}

/** The message of the call failure `invalid-input`: each issue with its path. */
function issueMessage(issues: readonly StandardSchemaV1.Issue[]): string {
  return issues
    .map((issue) => `${(issue.path ?? []).map((key) => (typeof key === "object" ? String(key.key) : String(key))).join(".") || "input"}: ${issue.message}`)
    .join("; ");
}

/** An observable whose values are copies, so that a client cannot change the data of the provider. */
function detached<T>(source: Observable<T>): Observable<T> {
  return {
    getSnapshot: () => structuredClone(source.getSnapshot()),
    subscribe: (listener) => source.subscribe((value) => listener(structuredClone(value))),
  };
}

/** Check a result against the output schema or the failure schemas. A result that does not agree is a defect. */
async function checkResult(capability: AnyCapability<never>, result: Result<unknown, unknown>): Promise<Outcome<unknown, unknown>> {
  if (result.ok) {
    if (capability.output === undefined) return { ok: true, value: result.value ?? null };
    const checked = await capability.output["~standard"].validate(result.value);
    if (checked.issues !== undefined) throw new Error(`The output does not agree with its schema: ${checked.issues[0]?.message}`);
    return { ok: true, value: checked.value };
  }
  const { error } = result;
  const tag = typeof error === "object" && error !== null && "_tag" in error ? error._tag : undefined;
  const schema = typeof tag === "string" ? capability.failures?.[tag] : undefined;
  if (typeof tag !== "string" || schema === undefined) throw new Error(`The failure ${String(tag)} is not in failures.`);
  const checked = await schema["~standard"].validate(error);
  if (checked.issues !== undefined) throw new Error(`The failure ${tag} does not agree with its schema: ${checked.issues[0]?.message}`);
  const data = typeof checked.value === "object" && checked.value !== null ? checked.value : {};
  return { ok: false, error: { _tag: tag, ...data } };
}

/**
 * Check a result of a typed handle, as `checkResult` does. The values come from the output schema and from the failure
 * schema, so they have the types of the capability.
 */
async function checkTyped<Context, Input, Value, Failures, State, Id extends string>(
  capability: Capability<Context, Input, Value, Failures, State, Id>,
  result: Result<Value, FailureOf<Failures>>,
): Promise<Result<Value, FailureOf<Failures>>> {
  if (result.ok) {
    if (capability.output === undefined) return result;
    const checked = await capability.output["~standard"].validate(result.value);
    if (checked.issues !== undefined) throw new Error(`The output does not agree with its schema: ${checked.issues[0]?.message}`);
    return { ok: true, value: checked.value };
  }
  if (capability.failures === undefined) throw new Error(`The failure ${String(result.error._tag)} is not in failures.`);
  return { ok: false, error: await checkFailure(result.error, result.error._tag, capability.failures) };
}

/** Check one failure against the schema of its tag. The result has the type of the failure with that tag. */
async function checkFailure<Failures, Tag extends keyof Failures>(
  failure: unknown,
  tag: Tag,
  schemas: FailureSchemas<Failures>,
): Promise<{ [Each in keyof Failures]: { readonly _tag: Each } & Failures[Each] }[Tag]> {
  const schema: StandardSchemaV1<unknown, Failures[Tag]> | undefined = schemas[tag];
  if (schema === undefined) throw new Error(`The failure ${String(tag)} is not in failures.`);
  const checked = await schema["~standard"].validate(failure);
  if (checked.issues !== undefined) throw new Error(`The failure ${String(tag)} does not agree with its schema: ${checked.issues[0]?.message}`);
  return { _tag: tag, ...checked.value };
}
