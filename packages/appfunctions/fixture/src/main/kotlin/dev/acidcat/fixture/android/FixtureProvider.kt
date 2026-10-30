/*
 * The conformance fixture as Android app functions. `acid-cat conform --appfunctions dev.acidcat.fixture` tests it.
 */
package dev.acidcat.fixture.android

import android.app.Application
import android.content.Context
import dev.acidcat.appfunctions.AppFunctionsBinding
import dev.acidcat.appfunctions.AppFunctionsProvider
import dev.acidcat.core.SessionOptions
import dev.acidcat.fixture.FixtureContext
import dev.acidcat.fixture.android.functions.FixtureAppFunctionServiceFunctions
import dev.acidcat.fixture.fixture
import kotlinx.coroutines.MainScope

/** The binding of the target android. All the calls of the process share one context, and so one switch and one set of holds. */
object FixtureProvider : AppFunctionsProvider {
    private val binding by lazy {
        AppFunctionsBinding(fixture, target = "android", context = FixtureContext(), options = SessionOptions(onDefect = { _, _ -> }))
    }

    override fun binding(context: Context): AppFunctionsBinding<*> = binding
}

/** Keeps the enabled state of the app functions equal to the availability of their capabilities. */
class FixtureApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        FixtureAppFunctionServiceFunctions.keepAvailability(this, MainScope())
    }
}
