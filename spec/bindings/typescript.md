# TypeScript binding

A language binding for TypeScript and JavaScript. A session exposes each capability in its view as a **handle**. The same shape serves code in the same process and adapters such as WebMCP, MCP and the CLI. It depends on [Catalog](../catalog.md) and [Invocation](../invocation.md).

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
  /** A typed call from code that already holds a decoded input. */
  execute(input: Input, options?: { signal?: AbortSignal }): Promise<Result<Value, Failure>>;
  /** A call with untrusted input, which is validated first. The result is in its encoded JSON form. */
  invokeExternal(input: unknown, options?: { signal?: AbortSignal }): Promise<Result<unknown, unknown>>;
}
```

- **Names.** A session gives access to every handle by id. It MAY also nest handles in an object tree. That tree is up to the application, and nothing is derived from it.
- **Outcomes.** A result resolves the promise. A call failure rejects it with an `Error` whose `kind` property is the kind. The error's `name` is `AbortError` for `cancelled` and `TypeError` for `invalid-input`.
- **Listing.** A session walks its handles. A handle outside the session's target reports itself unavailable, so adapters filter on availability alone.
- **Cancellation.** `options.signal` cancels one call. The session has its own signal, which cancels everything it started.
- **State.** `snapshot` observes the capability's [state](../invocation.md#state), and is present when the capability declares `state`. A handle MAY also offer a `snapshot` for in-process clients when the catalog declares no `state`. Other bindings cannot see that snapshot. Every value read from `getSnapshot`, or passed to a listener, is detached from the provider's own data.
- **Types.** `Input`, `Value`, `Failure` and `State` are generated from the catalog's schemas, or written by hand and checked against them.

A session is disposed with `dispose(): Promise<void>`, which follows the [session lifecycle](../invocation.md#sessions).

## Rationale

*This section is not normative.*

**This is the shape both kernels already have.** Jarette's Box and heb-stack expose `id`, `description`, `audience`, `availability`, an optional `snapshot`, `execute` and `invokeExternal`, and they use `getSnapshot` and `subscribe` sources. Adding `kind` to rejected errors is the only change. The member keeps the name `snapshot`, which both codebases and XState already use, for what the core calls state. Effect, XState and the composition of the root stay implementation choices, recorded in `ref/ts/`.
