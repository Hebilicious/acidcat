/*
 * The air conditioner of `catalog/aircon.acidcat.json`, written with acid-cat-core-kotlin. The unit is simulated in
 * memory. The command line, the MCP server and the Android app serve these capabilities.
 */
package dev.acidcat.example.aircon

import dev.acidcat.core.App
import dev.acidcat.core.Availability
import dev.acidcat.core.Maximum
import dev.acidcat.core.Minimum
import dev.acidcat.core.Result
import dev.acidcat.core.SharedType
import dev.acidcat.core.Target
import dev.acidcat.core.capabilitiesFor
import dev.acidcat.core.fail
import dev.acidcat.core.ok
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.coroutines.flow.update
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable

// --- Types -------------------------------------------------------------------------------------------------------

@Serializable
@SharedType
public enum class Mode {
    @SerialName("cool") Cool,
    @SerialName("heat") Heat,
    @SerialName("dry") Dry,
    @SerialName("fan") Fan,
    @SerialName("auto") Auto,
}

@Serializable
@SharedType
public enum class FanSpeed {
    @SerialName("auto") Auto,
    @SerialName("low") Low,
    @SerialName("medium") Medium,
    @SerialName("high") High,
}

@Serializable
@SharedType
public enum class Day {
    @SerialName("mon") Mon,
    @SerialName("tue") Tue,
    @SerialName("wed") Wed,
    @SerialName("thu") Thu,
    @SerialName("fri") Fri,
    @SerialName("sat") Sat,
    @SerialName("sun") Sun,
}

/** An hour of the day, from 0 to 23. In JSON, it is the number. */
@Serializable
@JvmInline
public value class Hour(@Minimum(0.0) @Maximum(23.0) public val value: Int)

@Serializable
@SharedType
public data class Status(
    val power: Boolean,
    val mode: Mode,
    val fan: FanSpeed,
    val targetCelsius: Double,
    val roomCelsius: Double,
)

@Serializable
@SharedType
public data class Schedule(val days: List<Day>, val hours: List<Hour>)

@Serializable
public data class PowerInput(val on: Boolean)

@Serializable
public data class ModeInput(val mode: Mode)

@Serializable
public data class TemperatureInput(@Minimum(16.0) @Maximum(31.0) val celsius: Double)

@Serializable
public data class FanInput(val speed: FanSpeed)

@Serializable
public data class ScheduleInput(val days: List<Day>, val hours: List<Hour>? = null)

/** The failures of the operations that need the unit online. */
@Serializable
public sealed interface OfflineFailure {
    /** The unit does not answer. */
    @Serializable
    @SerialName("Offline")
    public data class Offline(val since: String? = null) : OfflineFailure, ModeFailure, FirmwareFailure
}

@Serializable
public sealed interface ModeFailure {
    /** The unit must be on before its mode can change. */
    @Serializable
    @SerialName("PoweredOff")
    public data object PoweredOff : ModeFailure
}

@Serializable
public sealed interface FirmwareFailure {
    @Serializable
    @SerialName("UpToDate")
    public data class UpToDate(val version: String) : FirmwareFailure
}

// --- The unit ----------------------------------------------------------------------------------------------------

/** The simulated unit. All the sessions of a process share one unit. */
public class AirConditioner {
    private val state = MutableStateFlow(Status(power = false, mode = Mode.Cool, fan = FanSpeed.Auto, targetCelsius = 22.0, roomCelsius = 25.0))
    private val connected = MutableStateFlow<Availability>(Availability.Available)

    /** The status of the unit, as clients observe it. */
    public val status: StateFlow<Status> = state.asStateFlow()

    /** The availability of the operations that need the unit online. */
    public val online: StateFlow<Availability> = connected.asStateFlow()

    /** The days and hours when the unit turns on. */
    public var schedule: Schedule = Schedule(emptyList(), emptyList())
        internal set

    public val firmware: String = "1.0.0"

    public val isOnline: Boolean get() = connected.value.available

    /** Connect or disconnect the unit, to see the failures and the availability that depend on it. */
    public fun setOnline(online: Boolean) {
        connected.value = if (online) Availability.Available else Availability.Unavailable("The unit is offline.")
    }

    internal fun change(update: (Status) -> Status) = state.update(update)
}

// --- The capabilities --------------------------------------------------------------------------------------------

private val everywhere = listOf("app", "taskbar", "cli", "mcp", "api", "phone")
private val controls = listOf("app", "cli", "mcp", "api", "phone")
private val capability = capabilitiesFor<AirConditioner>()

public val statusGet =
    capability("aircon.status.get", "Read the unit's power, mode, fan speed, target temperature and room temperature.", everywhere)
        .readOnly()
        .output<Status>()
        .failures<OfflineFailure>()
        .state<Status> { it.status }
        .run { if (context.isOnline) ok(context.status.value) else fail(OfflineFailure.Offline()) }

public val powerSet =
    capability("aircon.power.set", "Turn the unit on or off.", everywhere)
        .input<PowerInput>()
        .failures<OfflineFailure>()
        .run { input -> context.changeIfOnline { it.copy(power = input.on) } }

public val modeSet =
    capability("aircon.mode.set", "Choose how the unit runs.", controls)
        .input<ModeInput>()
        .failures<ModeFailure>()
        .run { input ->
            when {
                !context.isOnline -> fail(OfflineFailure.Offline())
                !context.status.value.power -> fail(ModeFailure.PoweredOff)
                else -> {
                    context.change { it.copy(mode = input.mode) }
                    ok()
                }
            }
        }

public val temperatureSet =
    capability("aircon.temperature.set", "Set the target temperature in degrees Celsius.", controls)
        .input<TemperatureInput>()
        .failures<OfflineFailure>()
        .run { input -> context.changeIfOnline { it.copy(targetCelsius = input.celsius) } }

public val fanSet =
    capability("aircon.fan.set", "Set the fan speed.", controls)
        .input<FanInput>()
        .failures<OfflineFailure>()
        .run { input -> context.changeIfOnline { it.copy(fan = input.speed) } }

public val scheduleSet =
    capability("aircon.schedule.set", "Turn the unit on at each given hour, on each given day. The default hour is 7.", controls)
        .input<ScheduleInput>()
        .output<Schedule>()
        .failures<OfflineFailure>()
        .run { input ->
            if (!context.isOnline) return@run fail(OfflineFailure.Offline())
            context.schedule = Schedule(input.days, input.hours ?: listOf(Hour(7)))
            ok(context.schedule)
        }

public val firmwareUpdate =
    capability("aircon.firmware.update", "Install the latest firmware. The unit restarts and is offline for about a minute.", listOf("app"))
        .failures<FirmwareFailure>()
        .availability { it.online }
        .run { fail(FirmwareFailure.UpToDate(context.firmware)) }

/** Change the unit if it is online. */
private fun AirConditioner.changeIfOnline(update: (Status) -> Status): Result<Unit, OfflineFailure> {
    if (!isOnline) return fail(OfflineFailure.Offline())
    change(update)
    return ok()
}

// --- The application ---------------------------------------------------------------------------------------------

public val aircon: App<AirConditioner> = App(
    title = "Living-room air conditioner",
    description = "Control and monitor one split-unit air conditioner on the home network.",
    targets = mapOf(
        "app" to Target(listOf("typescript", "acme:swift", "kotlin"), description = "The phone, desktop and web apps that people use."),
        "taskbar" to Target(listOf("typescript"), description = "A desktop taskbar widget showing the status and a power toggle."),
        "cli" to Target(listOf("cli")),
        "mcp" to Target(listOf("mcp"), description = "Agents, through an MCP server."),
        "api" to Target(listOf("http"), description = "Home-automation systems and scripts."),
        "phone" to Target(listOf("appfunctions"), description = "Agents on an Android phone, through app functions."),
    ),
    capabilities = listOf(statusGet, powerSet, modeSet, temperatureSet, fanSet, scheduleSet, firmwareUpdate),
)

