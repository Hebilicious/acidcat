# TypeScript binding

The language binding for TypeScript and JavaScript. It maps the [programmatic binding](programmatic.md) to TypeScript. The rules of the programmatic binding apply. This document tells only the TypeScript forms. Protocol bindings, such as WebMCP, MCP and the command line, use the same handles.

## Handles

```ts
interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: (value: T) => void): { unsubscribe(): void };
}

type Availability = { available: true } | { available: false; reason: string };
type Result<Value, Failure> = { ok: true; value: Value } | { ok: false; error: Failure };

interface Handle<Input, Value, Failure, State = never> {
  readonly id: string;
  readonly description: string;
  readonly audience: readonly string[];
  readonly availability: Observable<Availability>;
  readonly snapshot?: Observable<State>;
  /** The typed call. */
  execute(input: Input, options?: { signal?: AbortSignal }): Promise<Result<Value, Failure>>;
  /** The external call. */
  invokeExternal(input: unknown, options?: { signal?: AbortSignal }): Promise<Result<unknown, unknown>>;
}
```

- **Handles.** A handle is an object. Each handle MUST have `execute` and `invokeExternal`.
- **Outcomes.** A result resolves the promise. A call failure rejects the promise with an `Error` that has a `kind` property. For `cancelled`, the `name` of the error is `AbortError`. For `invalid-input`, it is `TypeError`.
- **Observable values.** `availability` and `snapshot` are `Observable` values. `getSnapshot` reads the latest value. `subscribe` calls the listener after the value changes, with the new value. `snapshot` observes the state.
- **Cancellation.** `options.signal` cancels one call.
- **Types.** Each type in `$defs` becomes a named TypeScript type. `Input`, `Value`, `Failure` and `State` come from the schemas of the capability. You can also write them by hand and check them against the catalog.

## Event handles

```ts
interface Occurrence<Payload> {
  readonly eventId: string;
  readonly name: string;
  readonly timestamp: string;
  readonly data: Payload;
  readonly cursor?: string;
  readonly truncated?: true;
}

interface SubscribeOptions {
  readonly signal?: AbortSignal;
  readonly cursor?: string;
  readonly maxAgeMs?: number;
}

interface EventHandle<Input, Payload> {
  readonly id: string;
  readonly description: string;
  readonly audience: readonly string[];
  /** The typed subscription. */
  subscribe(input: Input, options?: SubscribeOptions): Promise<AsyncIterable<Occurrence<Payload>>>;
  /** The external subscription. */
  subscribeExternal(input: unknown, options?: SubscribeOptions): Promise<AsyncIterable<Occurrence<unknown>>>;
}
```

- **Event handles.** An event handle is an object. Each event handle MUST have `subscribe` and `subscribeExternal`.
- **Subscribing.** The promise resolves when the subscription has started. A call failure before the first occurrence rejects the promise with an `Error` that has a `kind` property, as for a call.
- **Occurrences.** Each value of the async iterable is an occurrence.
- **Ending.**

  | End | The iterator |
  | --- | --- |
  | Complete | `next()` resolves with `done: true` |
  | Cancelled | `next()` resolves with `done: true` |
  | `internal` | `next()` rejects with an `Error` whose `kind` is `internal`. After that, `next()` resolves with `done: true` |

- **Cancellation.** `return()` of the iterator cancels the subscription. It MUST work while a `next()` waits: that `next()` then resolves with `done: true`. `options.signal` also cancels the subscription, and so does the signal of the session. A `for await` loop that stops early calls `return()`.
- **Types.** `Input` and `Payload` come from the schemas of the event.

A GraphQL server can use an event handle as the source of a subscription. The `subscribe` resolver of a field returns the promise of `subscribe`. GraphQL calls `return()` when the client ends the subscription, through WebSockets or through server-sent events.

## Sessions

- **Opening.** A function of the core opens a session for one target, and gives the session object. It is `createSession` in `@acid-cat/core-ts` and `Handles.open` in `@acid-cat/core-effect`.
- **Handles.** `handles` is a `ReadonlyMap` of the handles, by id. The session also has a `ReadonlyMap` of the event handles, by id. `view` is the view of the target, as a catalog document.
- **Closing.** `dispose(): Promise<void>` closes a session.
- **Signal.** The session has its own `signal`, an `AbortSignal`. It aborts when the session starts to close, and it cancels all the work of the session.
