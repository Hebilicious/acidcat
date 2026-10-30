/*
 * One air conditioner for the whole process. The screen of the app and the agents on the phone use the same unit, so a
 * change from an agent shows on the screen at once.
 */
package dev.acidcat.example.aircon.android

import android.app.Application
import android.content.Context
import dev.acidcat.appfunctions.AppFunctionsBinding
import dev.acidcat.appfunctions.AppFunctionsProvider
import dev.acidcat.example.aircon.AirConditioner
import dev.acidcat.example.aircon.aircon
import dev.acidcat.example.aircon.android.functions.AirconAppFunctionServiceFunctions
import kotlinx.coroutines.MainScope

/** The unit, and the binding of the target phone: the app functions that agents call. */
object Aircon : AppFunctionsProvider {
    val unit = AirConditioner()

    private val binding by lazy { AppFunctionsBinding(aircon, target = "phone", context = unit) }

    override fun binding(context: Context): AppFunctionsBinding<*> = binding
}

/** Keeps the enabled state of each app function equal to the availability of its capability. */
class AirconApplication : Application() {
    override fun onCreate() {
        super.onCreate()
        AirconAppFunctionServiceFunctions.keepAvailability(this, MainScope())
    }
}
