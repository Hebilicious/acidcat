# TypeScript binding

A language binding for TypeScript and JavaScript. A session gives a **handle** for each capability in its view. Code in the same process uses handles. Protocol bindings, such as WebMCP, MCP and the command line, use the same handles.

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
  /** A call with an input that is already decoded. */
  execute(input: Input, options?: { signal?: AbortSignal }): Promise<Result<Value, Failure>>;
  /** A call with an input that is not trusted. The handle validates it first. The result is in its JSON form. */
  invokeExternal(input: unknown, options?: { signal?: AbortSignal }): Promise<Result<unknown, unknown>>;
}
```

- **Names.** A session gives each handle by id. It MAY also put the handles in a tree of objects. The application chooses the tree. No name comes from the tree.
- **Outcomes.** A result resolves the promise. A call failure rejects the promise with an `Error` that has a `kind` property. For `cancelled`, the `name` of the error is `AbortError`. For `invalid-input`, it is `TypeError`.
- **Listing.** A session gives all its handles. A handle that is not in the view of the target is always unavailable.
- **Cancellation.** `options.signal` cancels one call. The session has its own signal. It cancels all the work of the session.
- **State.** `snapshot` observes the [state](../invocation.md#state) of the capability. It is present when the capability has `state`. A handle MAY have a `snapshot` for code in the same process when the catalog has no `state`. Each value from `getSnapshot` or from a listener is a copy. It is not the data of the provider.
- **Types.** Each type in `$defs` becomes a named TypeScript type. `Input`, `Value`, `Failure` and `State` come from the schemas of the capability. You can also write them by hand and check them against the catalog.

`dispose(): Promise<void>` closes a session. It follows the [session lifecycle](../invocation.md#sessions).
