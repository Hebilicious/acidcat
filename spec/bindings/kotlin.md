# Kotlin binding

A language binding for Kotlin, on the JVM and on Android. A session gives a **handle** for each capability in its view. Code in the same process uses handles. Protocol bindings, for example MCP and the command line, use the same sessions.

The binding uses coroutines for calls and cancellation, and kotlinx.serialization for JSON values.

## Handles

```kotlin
sealed interface Availability {
    data object Available : Availability
    data class Unavailable(val reason: String) : Availability
}

sealed interface Result<out Value, out Failure> {
    data class Ok<out Value>(val value: Value) : Result<Value, Nothing>
    data class Failed<out Failure>(val error: Failure) : Result<Nothing, Failure>
}

interface Handle<in Input, out Value, out Failure, out State> {
    val id: String
    val description: String
    val audience: List<String>
    val availability: StateFlow<Availability>
    val snapshot: StateFlow<State>?
    /** A call with an input that the types already check. */
    suspend fun execute(input: Input): Result<Value, Failure>
    /** A call with an input that is not trusted. The handle validates it first. The result is in its JSON form. */
    suspend fun invokeExternal(input: JsonElement): Result<JsonElement, JsonObject>
}
```

- **Names.** A session gives each handle by id. It MAY also give a handle for a capability object, with the types of that capability. No name comes from the type.
- **Outcomes.** A result is the return value. A call failure throws an exception that has a `kind` property. For `cancelled`, the exception is a `CancellationException`, as coroutines expect. For the other kinds, it is not a `CancellationException`.
- **Listing.** A session gives all its handles. A handle that is not in the view of the target is always unavailable, and each call fails as `unknown-capability`.
- **Cancellation.** The cancellation of the coroutine of the caller cancels one call. The call ends at that time, also if the work of the capability does not stop. `close()` cancels all the work of the session.
- **State.** `snapshot` observes the [state](../invocation.md#state) of the capability. It is present when the capability has `state`. Each value is immutable, so a client cannot change the data of the provider.
- **Types.** `Input`, `Value`, `Failure` and `State` are Kotlin types. Their schemas can come from the types, or the types can come from the schemas. The JSON of a value is the JSON that kotlinx.serialization writes for its type.
- **Failures.** The failures of a capability are a sealed class. Each subclass is one tag. Its serial name is the tag, and the JSON of a failure has the tag in `_tag`.

`suspend fun close()` closes a session. It follows the [session lifecycle](../invocation.md#sessions).
