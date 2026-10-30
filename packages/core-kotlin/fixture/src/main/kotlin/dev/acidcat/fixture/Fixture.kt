/*
 * The conformance fixture (spec/conformance.md#the-conformance-fixture): one capability for each behavior that
 * `acid-cat conform` tests.
 */
package dev.acidcat.fixture

import dev.acidcat.core.App
import dev.acidcat.core.Availability
import dev.acidcat.core.Target
import dev.acidcat.core.capabilitiesFor
import dev.acidcat.core.fail
import dev.acidcat.core.ok
import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.StateFlow
import kotlinx.coroutines.flow.asStateFlow
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject

/** A switch that the tests turn on and off, to change the availability of `fixture.toggle`. */
public class Switch {
    private val state = MutableStateFlow<Availability>(Availability.Available)
    public val availability: StateFlow<Availability> = state.asStateFlow()

    public fun set(on: Boolean) {
        state.value = if (on) Availability.Available else Availability.Unavailable("The switch is off.")
    }
}

/**
 * The calls to `fixture.hold` that hold now, for all the sessions of one provider. `mark` writes the file of a marker. A
 * provider that cannot write files gives no `mark`.
 */
public class Holds(private val mark: ((String) -> Unit)? = null) {
    private class Entry(val key: String, val released: CompletableDeferred<Unit> = CompletableDeferred())

    private val holding = mutableListOf<Entry>()

    /** Hold until `release` releases the key, or until the coroutine is cancelled. */
    public suspend fun hold(key: String, marker: String?) {
        val entry = Entry(key)
        synchronized(holding) { holding += entry }
        try {
            if (marker != null) mark?.invoke(marker)
            entry.released.await()
        } finally {
            synchronized(holding) { holding -= entry }
        }
    }

    public fun held(): List<String> = synchronized(holding) { holding.map { it.key } }

    public fun release(key: String) {
        synchronized(holding) { holding.filter { it.key == key } }.forEach { it.released.complete(Unit) }
    }
}

/** The services of the fixture. */
public class FixtureContext(public val switch: Switch = Switch(), public val holds: Holds = Holds())

@Serializable
public data class Text(val text: String)

@Serializable
public data class Key(val key: String)

@Serializable
public data class Keys(val keys: List<String>)

@Serializable
public data class HoldInput(val key: String, val marker: String? = null)

@Serializable
public data class SwitchInput(val on: Boolean)

@Serializable
public data object Empty

@Serializable
public enum class Mode {
    @SerialName("fast")
    Fast,

    @SerialName("slow")
    Slow,
}

@Serializable
public data class Flags(
    val mode: Mode,
    val count: Long? = null,
    val ratio: Double? = null,
    val label: String? = null,
    val verbose: Boolean? = null,
    val extra: JsonObject? = null,
    val steps: List<Long>? = null,
    val tags: List<String>? = null,
)

@Serializable
public sealed interface RefuseFailure {
    @Serializable
    @SerialName("Refused")
    public data class Refused(val reason: String) : RefuseFailure
}

private val everywhere = listOf("app", "mcp", "cli", "api")
private val capability = capabilitiesFor<FixtureContext>()

public val echo: dev.acidcat.core.Capability<FixtureContext, Text, Text, Nothing, Nothing> =
    capability("fixture.echo", "Return the input text.", everywhere)
        .readOnly()
        .input<Text>()
        .output<Text>()
        .run { input -> ok(input) }

public val fixture: App<FixtureContext> = App(
    title = "Fixture",
    description = "One capability for each behavior that acid-cat conform tests.",
    targets = mapOf(
        "app" to Target(listOf("kotlin")),
        "mcp" to Target(listOf("mcp")),
        "cli" to Target(listOf("cli")),
        "api" to Target(listOf("http")),
    ),
    capabilities = listOf(
        echo,
        capability("fixture.refuse", "Always return the failure Refused.", everywhere)
            .failures<RefuseFailure>()
            .run { fail(RefuseFailure.Refused(reason = "No.")) },
        capability("fixture.crash", "Always fail with a defect.", everywhere)
            .run { throw IllegalStateException("secret internal detail") },
        capability(
            "fixture.hold",
            "Hold until fixture.release releases the key, then return the key. While the call holds, fixture.held gives the key. " +
                "With a marker, the call writes a file at that path when it starts to hold.",
            everywhere,
        )
            .input<HoldInput>()
            .output<Key>()
            .run { input ->
                context.holds.hold(input.key, input.marker)
                ok(Key(input.key))
            },
        capability("fixture.held", "Return the keys of the calls to fixture.hold that hold now.", everywhere)
            .readOnly()
            .output<Keys>()
            .run { ok(Keys(context.holds.held())) },
        capability("fixture.release", "Release the calls to fixture.hold that hold the key.", everywhere)
            .input<Key>()
            .run { input ->
                context.holds.release(input.key)
                ok()
            },
        capability("fixture.hidden", "Only the app target can use this capability.", listOf("app"))
            .run { ok() },
        capability("fixture.toggle", "Available only while the switch is on.", everywhere)
            .input<Empty>()
            .availability { it.switch.availability }
            .run { ok() },
        capability("fixture.switch.set", "Turn the switch on or off. The switch controls the availability of fixture.toggle.", everywhere)
            .input<SwitchInput>()
            .run { input ->
                context.switch.set(input.on)
                ok()
            },
        capability("fixture.flags", "Return the input. The input has one property for each kind of command-line flag.", listOf("cli"))
            .input<Flags>()
            .output<Flags>()
            .run { input -> ok(input) },
    ),
)
