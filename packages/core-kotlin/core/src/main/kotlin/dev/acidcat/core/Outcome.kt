/*
 * Outcomes, call failures and availability (spec/invocation.md).
 */
package dev.acidcat.core

import kotlinx.coroutines.CancellationException
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put

/** A value or a failure (spec/invocation.md#outcomes). */
public sealed interface Result<out Value, out Failure> {
    /** The capability did the operation. */
    public data class Ok<out Value>(val value: Value) : Result<Value, Nothing>

    /** The capability did not do the operation, for a reason in its `failures`. */
    public data class Failed<out Failure>(val error: Failure) : Result<Nothing, Failure>
}

/** A result with a value. */
public fun <Value> ok(value: Value): Result<Value, Nothing> = Result.Ok(value)

/** A result with no value, for a capability that has no output schema. */
public fun ok(): Result<Unit, Nothing> = Result.Ok(Unit)

/** A result with a failure. */
public fun <Failure> fail(failure: Failure): Result<Nothing, Failure> = Result.Failed(failure)

/** The kinds of call failure, in order of precedence: when more than one applies, the first one is used. */
public enum class CallFailureKind(public val text: String) {
    Cancelled("cancelled"),
    UnknownCapability("unknown-capability"),
    Unavailable("unavailable"),
    InvalidInput("invalid-input"),
    Internal("internal");

    public companion object {
        /** The kind with the text `text`, as the JSON form writes it. */
        public fun of(text: String): CallFailureKind? = entries.firstOrNull { it.text == text }
    }
}

/** A call that did not give a result. */
public data class CallFailure(val kind: CallFailureKind, val message: String)

/** The end of a call: a result, or a call failure. Bindings use the JSON form of each one. */
public sealed interface Outcome {
    /** A value or a failure, in its JSON form. */
    public data class Completed(val result: Result<JsonElement, JsonObject>) : Outcome

    /** A call that did not give a result. */
    public data class Failed(val failure: CallFailure) : Outcome

    public companion object {
        internal fun failed(kind: CallFailureKind, message: String): Outcome = Failed(CallFailure(kind, message))
    }
}

/**
 * The JSON form of an outcome (schemas/outcome.schema.json): `{ "ok": true, "value": … }`, `{ "ok": false, "error": … }`,
 * or `{ "kind": …, "message": … }`.
 */
public fun Outcome.toJson(): JsonObject = when (this) {
    is Outcome.Completed -> result.toJson()
    is Outcome.Failed -> failure.toJson()
}

/** The JSON form of a result. */
public fun Result<JsonElement, JsonObject>.toJson(): JsonObject = when (this) {
    is Result.Ok -> buildJsonObject {
        put("ok", true)
        put("value", value)
    }
    is Result.Failed -> buildJsonObject {
        put("ok", false)
        put("error", error)
    }
}

/** The JSON form of a call failure. */
public fun CallFailure.toJson(): JsonObject = buildJsonObject {
    put("kind", JsonPrimitive(kind.text))
    put("message", message)
}

/**
 * The exception of a call failure (spec/bindings/kotlin.md#handles). A handle throws it when a call gives no result.
 * A call that is cancelled throws [CallCancelledException] instead, because coroutines expect a [CancellationException].
 */
public sealed interface CallFailureThrowable {
    public val failure: CallFailure
    public val kind: CallFailureKind get() = failure.kind
}

/** A call failure that is not `cancelled`. */
public class CallFailureException(override val failure: CallFailure) : Exception(failure.message), CallFailureThrowable

/** The call failure `cancelled`. */
public class CallCancelledException(override val failure: CallFailure = CallFailure(CallFailureKind.Cancelled, "The call was cancelled.")) :
    CancellationException(failure.message), CallFailureThrowable

/** The exception that a handle throws for a call failure. */
public fun CallFailure.toThrowable(): Throwable =
    if (kind == CallFailureKind.Cancelled) CallCancelledException(this) else CallFailureException(this)

/** If a capability can run now in a session (spec/invocation.md#availability). */
public sealed interface Availability {
    public val available: Boolean

    public data object Available : Availability {
        override val available: Boolean get() = true
    }

    public data class Unavailable(val reason: String) : Availability {
        override val available: Boolean get() = false
    }

    public companion object {
        /** An unavailability with a reason. */
        public fun unavailable(reason: String): Availability = Unavailable(reason)
    }
}

/** The JSON form of an availability: `{ "available": true }` or `{ "available": false, "reason": … }`. */
public fun Availability.toJson(): JsonObject = buildJsonObject {
    put("available", available)
    if (this@toJson is Availability.Unavailable) put("reason", reason)
}
