/*
 * The screen of the app: the target app, through the Kotlin binding. It shows the status of the unit as its state
 * changes, and calls the capabilities with their Kotlin types.
 */
package dev.acidcat.example.aircon.android

import android.app.Activity
import android.os.Bundle
import android.view.WindowInsets
import android.widget.Button
import android.widget.LinearLayout
import android.widget.TextView
import dev.acidcat.core.CallFailureException
import dev.acidcat.core.Result
import dev.acidcat.core.Session
import dev.acidcat.core.openSession
import dev.acidcat.example.aircon.AirConditioner
import dev.acidcat.example.aircon.Mode
import dev.acidcat.example.aircon.ModeInput
import dev.acidcat.example.aircon.PowerInput
import dev.acidcat.example.aircon.Status
import dev.acidcat.example.aircon.TemperatureInput
import dev.acidcat.example.aircon.aircon
import dev.acidcat.example.aircon.modeSet
import dev.acidcat.example.aircon.powerSet
import dev.acidcat.example.aircon.statusGet
import dev.acidcat.example.aircon.temperatureSet
import kotlinx.coroutines.MainScope
import kotlinx.coroutines.cancel
import kotlinx.coroutines.launch

class MainActivity : Activity() {
    private val scope = MainScope()
    private lateinit var session: Session<AirConditioner>

    override fun onCreate(savedInstanceState: Bundle?) {
        super.onCreate(savedInstanceState)
        // The session of the screen. It closes with the screen.
        session = aircon.openSession("app", Aircon.unit)
        val status = TextView(this).apply { textSize = 20f }
        val message = TextView(this)

        /** Call a capability, and show its failure or its call failure. */
        fun <F> act(call: suspend () -> Result<Unit, F>) {
            scope.launch {
                message.text = try {
                    when (val result = call()) {
                        is Result.Ok -> ""
                        is Result.Failed -> "The unit says no: ${result.error}"
                    }
                } catch (failure: CallFailureException) {
                    "The call did not run: ${failure.failure.message}"
                }
            }
        }

        val power = session.handle(powerSet)
        val temperature = session.handle(temperatureSet)
        val mode = session.handle(modeSet)
        val current = { Aircon.unit.status.value }
        val buttons = listOf(
            button("Power") { act { power.execute(PowerInput(on = !current().power)) } },
            button("Warmer") { act { temperature.execute(TemperatureInput(current().targetCelsius + 1)) } },
            button("Cooler") { act { temperature.execute(TemperatureInput(current().targetCelsius - 1)) } },
            button("Heat") { act { mode.execute(ModeInput(Mode.Heat)) } },
            button("Cool") { act { mode.execute(ModeInput(Mode.Cool)) } },
        )
        setContentView(
            LinearLayout(this).apply {
                orientation = LinearLayout.VERTICAL
                // The window goes under the system bars, so the content keeps out of them.
                setOnApplyWindowInsetsListener { view, insets ->
                    val bars = insets.getInsets(WindowInsets.Type.systemBars())
                    view.setPadding(48, bars.top + 48, 48, bars.bottom + 48)
                    insets
                }
                addView(status)
                buttons.forEach(::addView)
                addView(message)
            },
        )

        // The state of aircon.status.get: each change shows at once, also a change from an agent.
        val snapshot = checkNotNull(session.handle(statusGet).snapshot) { "aircon.status.get has a state." }
        scope.launch { snapshot.collect { status.text = describe(it) } }
    }

    override fun onDestroy() {
        scope.cancel()
        MainScope().launch { session.close() }
        super.onDestroy()
    }

    private fun button(label: String, onClick: () -> Unit) = Button(this).apply {
        text = label
        setOnClickListener { onClick() }
    }

    private fun describe(status: Status): String =
        "${if (status.power) "On" else "Off"}, ${status.mode.name.lowercase()}, fan ${status.fan.name.lowercase()}\n" +
            "Target ${status.targetCelsius} °C, room ${status.roomCelsius} °C"
}
