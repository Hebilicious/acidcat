package dev.acidcat.example.aircon

import dev.acidcat.core.AcidCatJson
import dev.acidcat.core.CallFailureException
import dev.acidcat.core.CallFailureKind
import dev.acidcat.core.CliIo
import dev.acidcat.core.CliSettings
import dev.acidcat.core.Result
import dev.acidcat.core.obj
import dev.acidcat.core.openSession
import dev.acidcat.core.runCli
import dev.acidcat.core.strings
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith

class AirconTest {
    /**
     * The parts of a catalog that do not depend on how its schemas are written: the targets, and for each capability its
     * audience, its failure tags, and if it is read-only or has state. The TypeScript examples compare the same parts.
     */
    private fun shape(catalog: JsonObject): Map<String, Any?> = mapOf(
        "targets" to catalog.obj("targets"),
        "capabilities" to catalog.obj("capabilities").orEmpty().mapValues { (_, value) ->
            val capability = value as JsonObject
            listOf(
                capability.strings("audience"),
                capability["readOnly"]?.toString() == "true",
                capability.obj("failures").orEmpty().keys.sorted(),
                "state" in capability,
            )
        },
    )

    @Test
    fun `the code writes a catalog that agrees with the shared catalog`() {
        val shared = AcidCatJson.parseToJsonElement(File(System.getProperty("aircon.catalog")).readText()) as JsonObject
        assertEquals(shape(shared), shape(aircon.catalog))
    }

    @Test
    fun `the unit works through a session, with its types`() = runBlocking {
        val unit = AirConditioner()
        aircon.openSession("app", unit).use { session ->
            assertEquals(Result.Failed(ModeFailure.PoweredOff), session.handle(modeSet).execute(ModeInput(Mode.Heat)))
            assertEquals(Result.Ok(Unit), session.handle(powerSet).execute(PowerInput(on = true)))
            assertEquals(true, session.handle(statusGet).snapshot?.value?.power)
            val invalid = assertFailsWith<CallFailureException> {
                session.call(temperatureSet, AcidCatJson.parseToJsonElement("""{ "celsius": 40 }"""))
            }
            assertEquals(CallFailureKind.InvalidInput, invalid.kind)
            unit.setOnline(false)
            assertEquals(Result.Failed(OfflineFailure.Offline()), session.handle(powerSet).execute(PowerInput(on = false)))
            assertEquals(false, session.handle(firmwareUpdate).availability.value.available)
        }
    }

    @Test
    fun `the command line takes a repeated flag, and the default hour is 7`() = runBlocking {
        val out = StringBuilder()
        val settings = CliSettings(name = "aircon", version = "0.1.0", context = AirConditioner())
        val code = runCli(aircon, settings, listOf("aircon", "schedule", "set", "--days", "mon", "--days", "fri"), CliIo({ out.append(it) }, {}))
        assertEquals(0, code)
        assertEquals(Schedule(listOf(Day.Mon, Day.Fri), listOf(Hour(7))), AcidCatJson.decodeFromString(Schedule.serializer(), out.toString()))
        assertEquals(3, runCli(aircon, settings, listOf("aircon", "schedule", "set", "--days", "mon", "--hours", "24"), CliIo({}, {})))
    }
}
