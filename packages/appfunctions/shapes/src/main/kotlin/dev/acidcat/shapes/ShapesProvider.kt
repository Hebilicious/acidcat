/*
 * The provider of the shapes. The build only compiles the app functions of the shapes, so the binding serves no
 * capability.
 */
package dev.acidcat.shapes

import android.content.Context
import dev.acidcat.appfunctions.AppFunctionsBinding
import dev.acidcat.appfunctions.AppFunctionsProvider
import dev.acidcat.core.App
import dev.acidcat.core.Target

object ShapesProvider : AppFunctionsProvider {
    private val binding = AppFunctionsBinding(
        App<Unit>(targets = mapOf("android" to Target(listOf("kotlin", "appfunctions"))), capabilities = emptyList()),
        target = "android",
        context = Unit,
    )

    override fun binding(context: Context): AppFunctionsBinding<*> = binding
}
