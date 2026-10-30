/*
 * The AppFunctions binding (spec/bindings/appfunctions.md): the capabilities of a target as Android app functions. The
 * Gradle plugin `dev.acidcat.appfunctions` generates one app function for each capability of the view. Each generated
 * function calls [AppFunctionsBinding.call].
 */
package dev.acidcat.appfunctions

import android.content.Context as AndroidContext
import android.util.Log
import androidx.appfunctions.AppFunctionAppUnknownException
import androidx.appfunctions.AppFunctionCancelledException
import androidx.appfunctions.AppFunctionDisabledException
import androidx.appfunctions.AppFunctionFunctionNotFoundException
import androidx.appfunctions.AppFunctionInvalidArgumentException
import androidx.appfunctions.AppFunctionManager
import dev.acidcat.core.App
import dev.acidcat.core.CallFailure
import dev.acidcat.core.CallFailureKind
import dev.acidcat.core.Outcome
import dev.acidcat.core.Result
import dev.acidcat.core.SessionOptions
import dev.acidcat.core.openSession
import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.Job
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.distinctUntilChanged
import kotlinx.coroutines.launch
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject

/**
 * Gives the binding of the generated service. The Gradle plugin names an `object` that implements this interface. The
 * object keeps the binding, so that all the services and all the calls of the process share one provider.
 */
public interface AppFunctionsProvider {
    /** The binding of the target. The first call can make it with the application context. */
    public fun binding(context: AndroidContext): AppFunctionsBinding<*>
}

/**
 * Serves one target of an application as app functions. Each execution of an app function is one call in its own
 * session (spec/invocation.md#sessions).
 */
public class AppFunctionsBinding<Context>(
    private val app: App<Context>,
    /** The target that the app functions serve. */
    public val target: String,
    private val context: Context,
    private val options: SessionOptions = SessionOptions(),
) {
    /**
     * Call a capability for one execution of its app function. `value` makes the return value from the JSON of a value,
     * and `failure` from the JSON of a failure. A call failure throws the [androidx.appfunctions.AppFunctionException]
     * of its kind. When the platform cancels the execution, the coroutine is cancelled, and so is the call.
     */
    public suspend fun <T> call(id: String, input: JsonObject, value: (JsonElement) -> T, failure: ((JsonObject) -> T)? = null): T {
        val outcome = app.openSession(target, context, options).use { session -> session.invoke(id, input) }
        return when (outcome) {
            is Outcome.Failed -> throw outcome.failure.toAppFunctionException()
            is Outcome.Completed -> when (val result = outcome.result) {
                is Result.Ok -> converted(id) { value(result.value) }
                is Result.Failed -> converted(id) {
                    failure?.invoke(result.error) ?: throw IllegalStateException("The app function of $id has no failures.")
                }
            }
        }
    }

    /** Make a return value. A value that the generated types cannot hold is a defect of the build. */
    private inline fun <T> converted(id: String, make: () -> T): T = try {
        make()
    } catch (cause: IllegalArgumentException) {
        options.onDefect(id, cause)
        throw AppFunctionAppUnknownException("The capability failed.")
    } catch (cause: IllegalStateException) {
        options.onDefect(id, cause)
        throw AppFunctionAppUnknownException("The capability failed.")
    }

    /**
     * Keep the enabled state of each app function equal to the availability of its capability, while `scope` is active
     * (spec/bindings/appfunctions.md#listing). `functionIds` gives the function identifier of each capability. The
     * generated object `<Service>Functions` has them. Start it when the process starts, in `Application.onCreate`.
     */
    public fun keepAvailability(androidContext: AndroidContext, functionIds: Map<String, String>, scope: CoroutineScope): Job = scope.launch {
        val manager = AppFunctionManager.getInstance(androidContext)
        if (manager == null) {
            Log.i(TAG, "AppFunctions is not available on this device.")
            return@launch
        }
        app.openSession(target, context, options).use { session ->
            for ((id, handle) in session.handles) {
                val functionId = functionIds[id] ?: continue
                launch {
                    handle.availability.distinctUntilChanged { old, new -> old.available == new.available }.collect { availability ->
                        val state = if (availability.available) AppFunctionManager.APP_FUNCTION_STATE_ENABLED else AppFunctionManager.APP_FUNCTION_STATE_DISABLED
                        try {
                            manager.setAppFunctionEnabled(functionId, state)
                        } catch (cause: IllegalArgumentException) {
                            Log.w(TAG, "The platform does not know the app function $functionId of $id.", cause)
                        }
                    }
                }
            }
            awaitCancellation()
        }
    }

    private companion object {
        const val TAG = "AcidCat"
    }
}

/** The exception of each kind of call failure (spec/bindings/appfunctions.md#outcomes). */
public fun CallFailure.toAppFunctionException(): Exception = when (kind) {
    CallFailureKind.Cancelled -> AppFunctionCancelledException(message)
    CallFailureKind.UnknownCapability -> AppFunctionFunctionNotFoundException(message)
    CallFailureKind.Unavailable -> AppFunctionDisabledException(message)
    CallFailureKind.InvalidInput -> AppFunctionInvalidArgumentException(message)
    CallFailureKind.Internal -> AppFunctionAppUnknownException(message)
}
