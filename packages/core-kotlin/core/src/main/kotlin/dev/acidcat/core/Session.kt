/*
 * Sessions and handles (spec/invocation.md, spec/bindings/kotlin.md).
 */
package dev.acidcat.core

import kotlinx.coroutines.CancellationException
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.CoroutineDispatcher
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.SupervisorJob
import kotlinx.coroutines.cancel
import kotlinx.coroutines.currentCoroutineContext
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.drop
import kotlinx.coroutines.flow.emptyFlow
import kotlinx.coroutines.flow.map
import kotlinx.coroutines.flow.merge
import kotlinx.coroutines.isActive
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlin.coroutines.cancellation.CancellationException as KotlinCancellation

/**
 * The handle of a capability (spec/bindings/kotlin.md#handles). `Input`, `Value`, `Failure` and `State` are the types
 * of the schemas of the capability. [Session.handle] gives a handle with these types. A handle of [Session.handles] has
 * the input type [Nothing]: only [invokeExternal] can call it, because it decodes the input.
 */
public interface Handle<in Input, out Value, out Failure, out State> {
    public val id: String
    public val description: String
    public val audience: List<String>
    public val availability: StateFlow<Availability>

    /** The state of the capability, if it has one. Each value is immutable. */
    public val snapshot: StateFlow<State>?

    /**
     * A call with an input that the types already check. A call failure throws a [CallFailureException], or a
     * [CallCancelledException] for `cancelled`. The cancellation of the coroutine of the caller cancels the call.
     */
    public suspend fun execute(input: Input): Result<Value, Failure>

    /** A call with an input that is not trusted. The result is in its JSON form. A call failure throws, as [execute] does. */
    public suspend fun invokeExternal(input: JsonElement): Result<JsonElement, JsonObject>
}

/** The options of a session. */
public class SessionOptions(
    /** Record a defect of a capability. The default writes it to the standard error. */
    public val onDefect: (id: String, cause: Throwable) -> Unit = { id, cause ->
        System.err.println("A capability failed with a defect: $id")
        cause.printStackTrace()
    },
    /** The dispatcher of the work of each call. */
    public val dispatcher: CoroutineDispatcher = Dispatchers.Default,
)

/** Open a session for a target (spec/invocation.md#sessions). */
public fun <Context> App<Context>.openSession(target: String, context: Context, options: SessionOptions = SessionOptions()): Session<Context> =
    Session(this, target, context, options)

/**
 * A session: one period in which one client calls the capabilities of one target. It is open, then closing, then
 * closed. [close] cancels the calls in progress.
 */
public class Session<Context> internal constructor(
    private val app: App<Context>,
    public val target: String,
    private val context: Context,
    private val options: SessionOptions,
) {
    private val scope = CoroutineScope(SupervisorJob() + options.dispatcher)
    private val running = mutableSetOf<Running>()
    private val lock = Any()
    private val phase = MutableStateFlow(Phase.Open)

    /** The capabilities that the session serves, by id: the capabilities whose audience has the target. */
    private val served: Map<String, Served<Context>> = buildMap {
        for (capability in app.capabilities) {
            if (target !in capability.audience) continue
            require(capability.id !in this) { "The capability ${capability.id} is declared two times." }
            put(capability.id, Served(capability, capability.availability?.invoke(context) ?: always))
        }
    }

    /** The view of the target (spec/catalog.md#views). Bindings take names, descriptions and schemas from it. */
    public val view: JsonObject by lazy { viewOf(app.catalog, target) }

    /** If the session accepts calls. */
    public val isOpen: Boolean get() = phase.value == Phase.Open

    /** The handles of the capabilities in the view, by id. Bindings use them. */
    public val handles: Map<String, Handle<Nothing, JsonElement, JsonObject, Any?>> =
        served.mapValues { (id, entry) -> ExternalHandle(id, entry) }

    /**
     * An event each time the availability of a capability changes. The flow collects the availabilities only while it
     * has a collector.
     */
    public val changes: Flow<Unit> =
        if (served.isEmpty()) emptyFlow() else merge(*served.values.map { it.availability.drop(1) }.toTypedArray()).map { }

    /**
     * The handle of a capability, with the types of the capability. Only the capability object that the session serves
     * gets a handle that calls it. Any other capability, also one with the same id, gets a handle that is always
     * unavailable, and each call fails as `unknown-capability`.
     */
    public fun <Input, Value, Failure, State> handle(capability: Capability<Context, Input, Value, Failure, State>): Handle<Input, Value, Failure, State> {
        val entry = served[capability.id]
        if (entry == null || entry.capability !== capability) return OutsideView(capability.id, capability.description)
        return TypedHandle(capability, entry)
    }

    /**
     * A call of a capability with an input that is not trusted. The input schema of the capability checks the input, so
     * the result has the types of the capability. A call failure throws, as [Handle.execute] does.
     */
    public suspend fun <Input, Value, Failure, State> call(
        capability: Capability<Context, Input, Value, Failure, State>,
        input: JsonElement,
    ): Result<Value, Failure> {
        val entry = served[capability.id]
        if (entry == null || entry.capability !== capability) throw unknown(capability.id).failure.toThrowable()
        return when (val outcome = perform(entry) { decoded(capability, input) { typed -> typedRun(capability, typed) } }) {
            is Performed.Done -> outcome.value
            is Performed.Failed -> throw outcome.failure.toThrowable()
        }
    }

    /** A call with an input that is not trusted. The outcome is in its JSON form. It throws only when the caller is cancelled. */
    public suspend fun invoke(id: String, input: JsonElement): Outcome {
        if (!isOpen) return Outcome.Failed(cancelled)
        val entry = served[id] ?: return Outcome.Failed(unknown(id).failure)
        return when (val outcome = perform(entry) { jsonCall(entry.capability, input) }) {
            is Performed.Done -> Outcome.Completed(outcome.value)
            is Performed.Failed -> Outcome.Failed(outcome.failure)
        }
    }

    /** Close the session: accept no new calls, cancel the calls in progress, and wait for their outcomes. */
    public suspend fun close() {
        val stopping = synchronized(lock) {
            if (phase.value == Phase.Open) phase.value = Phase.Closing
            running.toList()
        }
        // Each outcome settles as `cancelled` here, so no caller waits for work that ignores its cancellation.
        stopping.forEach { it.cancel() }
        scope.cancel()
        phase.value = Phase.Closed
    }

    /** Run a block with the session, and close it at the end. */
    public suspend fun <R> use(block: suspend (Session<Context>) -> R): R = try {
        block(this)
    } finally {
        close()
    }

    /**
     * Run a call: availability, then the decoded input, then the work, with cancellation. A defect is the call failure
     * `internal`. The outcome comes when the work ends or when the call is cancelled, also if the work ignores the
     * cancellation.
     */
    private suspend fun <T> perform(entry: Served<Context>, prepare: suspend () -> Prepared<Context, T>): Performed<T> {
        if (!isOpen) return Performed.Failed(cancelled)
        val availability = entry.availability.value
        if (availability is Availability.Unavailable) return Performed.Failed(CallFailure(CallFailureKind.Unavailable, availability.reason))
        val start = when (val prepared = prepare()) {
            is Prepared.Invalid -> return Performed.Failed(CallFailure(CallFailureKind.InvalidInput, prepared.message))
            is Prepared.Ready -> prepared.start
        }

        val outcome = CompletableDeferred<Performed<T>>()
        val call = Call(context, entry.capability.id)
        val registered = synchronized(lock) {
            if (phase.value != Phase.Open) return@synchronized null
            val work = scope.launch(start = CoroutineStart.LAZY) {
                val settled = try {
                    Performed.Done(start(call))
                } catch (cause: KotlinCancellation) {
                    if (!currentCoroutineContext().isActive) Performed.Failed(cancelled) else defect(entry.capability.id, cause)
                } catch (cause: Throwable) {
                    defect(entry.capability.id, cause)
                }
                outcome.complete(settled)
            }
            Running(work) { outcome.complete(Performed.Failed(cancelled)) }.also { running += it }
        } ?: return Performed.Failed(cancelled)
        registered.work.start()
        try {
            return outcome.await()
        } catch (cause: CancellationException) {
            registered.cancel()
            throw cause
        } finally {
            synchronized(lock) { running -= registered }
        }
    }

    private fun <T> defect(id: String, cause: Throwable): Performed<T> {
        options.onDefect(id, cause)
        return Performed.Failed(CallFailure(CallFailureKind.Internal, "The capability failed."))
    }

    /** Decode an input that is not trusted with the input schema of a capability, then give the start of the work. */
    private fun <Input, T> decoded(
        capability: Capability<Context, Input, *, *, *>,
        input: JsonElement,
        start: (Input) -> (suspend (Call<Context>) -> T),
    ): Prepared<Context, T> {
        if (capability.input === NoInput) {
            // With no input schema, the input is an empty object (spec/catalog.md#capabilities).
            if (input !is JsonObject) return Prepared.Invalid("input: the input must be an object.")
            return Prepared.Ready(start(capability.input.decode(JsonObject(emptyMap()))))
        }
        val problems = capability.input.problems(input)
        if (problems.isNotEmpty()) return Prepared.Invalid(problems.joinToString("; "))
        val decoded = try {
            capability.input.decode(input)
        } catch (cause: IllegalArgumentException) {
            return Prepared.Invalid("input: ${cause.message}")
        }
        return Prepared.Ready(start(decoded))
    }

    /** Decode an input that is not trusted, then give the work of a call in JSON. */
    private fun <Input> jsonCall(capability: Capability<Context, Input, *, *, *>, input: JsonElement): Prepared<Context, Result<JsonElement, JsonObject>> =
        decoded(capability, input) { typed -> jsonRun(capability, typed) }

    /** The work of a typed call: run, then check the result against the output schema or the failure schemas. */
    private fun <Input, Value, Failure> typedRun(capability: Capability<Context, Input, Value, Failure, *>, input: Input): suspend (Call<Context>) -> Result<Value, Failure> = { call ->
        val result = capability.run(call, input)
        checked(capability, result)
        result
    }

    /** The work of a call in JSON: run, then give the result in its JSON form, checked against its schemas. */
    private fun <Input, Value, Failure> jsonRun(capability: Capability<Context, Input, Value, Failure, *>, input: Input): suspend (Call<Context>) -> Result<JsonElement, JsonObject> = { call ->
        checked(capability, capability.run(call, input))
    }

    /** The JSON form of a result. A result that does not agree with its schema is a defect, and throws. */
    private fun <Value, Failure> checked(capability: Capability<Context, *, Value, Failure, *>, result: Result<Value, Failure>): Result<JsonElement, JsonObject> =
        when (result) {
            is Result.Ok -> {
                if (capability.output === NoOutput) {
                    Result.Ok(JsonNull)
                } else {
                    val json = capability.output.encode(result.value)
                    val problems = capability.output.problems(json)
                    check(problems.isEmpty()) { "The output does not agree with its schema: ${problems.first()}" }
                    Result.Ok(json)
                }
            }
            is Result.Failed -> {
                val failures = capability.failures ?: throw IllegalStateException("The capability ${capability.id} has no failures.")
                Result.Failed(failures.encode(result.error))
            }
        }

    private inner class ExternalHandle(override val id: String, private val entry: Served<Context>) : Handle<Nothing, JsonElement, JsonObject, Any?> {
        override val description: String get() = entry.capability.description
        override val audience: List<String> get() = listOf(target)
        override val availability: StateFlow<Availability> get() = entry.availability
        override val snapshot: StateFlow<Any?>? = entry.capability.state?.source?.invoke(context)

        override suspend fun execute(input: Nothing): Result<JsonElement, JsonObject> = input

        override suspend fun invokeExternal(input: JsonElement): Result<JsonElement, JsonObject> = when (val outcome = invoke(id, input)) {
            is Outcome.Completed -> outcome.result
            is Outcome.Failed -> throw outcome.failure.toThrowable()
        }
    }

    private inner class TypedHandle<Input, Value, Failure, State>(
        private val capability: Capability<Context, Input, Value, Failure, State>,
        private val entry: Served<Context>,
    ) : Handle<Input, Value, Failure, State> {
        override val id: String get() = capability.id
        override val description: String get() = capability.description
        override val audience: List<String> get() = listOf(target)
        override val availability: StateFlow<Availability> get() = entry.availability
        override val snapshot: StateFlow<State>? = capability.state?.source?.invoke(context)

        override suspend fun execute(input: Input): Result<Value, Failure> =
            when (val outcome = perform(entry) { Prepared.Ready<Context, Result<Value, Failure>>(typedRun(capability, input)) }) {
                is Performed.Done -> outcome.value
                is Performed.Failed -> throw outcome.failure.toThrowable()
            }

        override suspend fun invokeExternal(input: JsonElement): Result<JsonElement, JsonObject> = handles.getValue(id).invokeExternal(input)
    }

    private class OutsideView(override val id: String, override val description: String) : Handle<Any?, Nothing, Nothing, Nothing> {
        private val failure = unknown(id)
        override val audience: List<String> get() = emptyList()
        override val availability: StateFlow<Availability> = MutableStateFlow(Availability.Unavailable(failure.failure.message)).asStateFlow()
        override val snapshot: StateFlow<Nothing>? get() = null
        override suspend fun execute(input: Any?): Nothing = throw failure
        override suspend fun invokeExternal(input: JsonElement): Nothing = throw failure
    }

    private class Served<Context>(val capability: Capability<Context, *, *, *, *>, val availability: StateFlow<Availability>)

    /** A call in progress: its work, and the function that settles its outcome as `cancelled`. */
    private class Running(val work: Job, private val settleCancelled: () -> Unit) {
        fun cancel() {
            work.cancel()
            settleCancelled()
        }
    }

    /** The input of a call, decoded: a problem, or the start of the work. */
    private sealed interface Prepared<in C, out T> {
        class Invalid(val message: String) : Prepared<Any?, Nothing>
        class Ready<C, T>(val start: suspend (Call<C>) -> T) : Prepared<C, T>
    }

    private sealed interface Performed<out T> {
        class Done<T>(val value: T) : Performed<T>
        class Failed(val failure: CallFailure) : Performed<Nothing>
    }

    private enum class Phase { Open, Closing, Closed }

    private companion object {
        val always: StateFlow<Availability> = MutableStateFlow(Availability.Available).asStateFlow()
        val cancelled = CallFailure(CallFailureKind.Cancelled, "The call was cancelled.")
        fun unknown(id: String) = CallFailureException(CallFailure(CallFailureKind.UnknownCapability, "There is no capability $id."))
    }
}
