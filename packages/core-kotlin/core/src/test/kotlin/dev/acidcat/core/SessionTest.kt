package dev.acidcat.core

import kotlinx.coroutines.CompletableDeferred
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.delay
import kotlinx.coroutines.async
import kotlinx.coroutines.awaitCancellation
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.flow.first
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeout
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs
import kotlin.test.assertTrue

/** An electric kettle, simulated in memory. */
class Kettle {
    val water = MutableStateFlow(Water(celsius = 20.0, litres = 1.0))
    val plugged = MutableStateFlow<Availability>(Availability.Available)
    val started = CompletableDeferred<Unit>()
    val cancelled = CompletableDeferred<Unit>()
}

@Serializable
data class Water(val celsius: Double, val litres: Double)

@Serializable
data class Fill(@Minimum(0.1) @Maximum(1.7) val litres: Double)

@Serializable
sealed interface KettleFailure {
    @Serializable
    @SerialName("Empty")
    data object Empty : KettleFailure

    @Serializable
    @SerialName("Overflow")
    data class Overflow(val litres: Double) : KettleFailure
}

private val capability = capabilitiesFor<Kettle>()

val fill = capability("kettle.water.fill", "Add water to the kettle.", listOf("app", "cli"))
    .input<Fill>()
    .output<Water>()
    .failures<KettleFailure>()
    .state<Water> { it.water }
    .run { input ->
        val water = context.water.value
        if (water.litres + input.litres > 1.7) return@run fail(KettleFailure.Overflow(water.litres + input.litres))
        context.water.value = water.copy(litres = water.litres + input.litres)
        ok(context.water.value)
    }

val boil = capability("kettle.boil", "Boil the water. The call holds until it is cancelled.", listOf("app"))
    .availability { it.plugged }
    .run {
        context.started.complete(Unit)
        try {
            awaitCancellation()
        } finally {
            context.cancelled.complete(Unit)
        }
    }

val stubborn = capability("kettle.stubborn", "Ignore cancellation.", listOf("app"))
    .run {
        context.started.complete(Unit)
        kotlinx.coroutines.withContext(kotlinx.coroutines.NonCancellable) { awaitCancellation() }
    }

val broken = capability("kettle.broken", "Return a value that does not agree with the output schema.", listOf("app"))
    .output(Schema.of(Water.serializer(), buildJsonObject { put("type", "string") }))
    .run { ok(Water(0.0, 0.0)) }

val hiddenFromApp = capability("kettle.hidden", "Only the cli target can use this capability.", listOf("cli"))
    .run { ok() }

val kettleApp = App(
    title = "Kettle",
    targets = mapOf("app" to Target(listOf("kotlin")), "cli" to Target(listOf("cli"))),
    capabilities = listOf(fill, boil, stubborn, broken, hiddenFromApp),
)

class SessionTest {
    private val quiet = SessionOptions(onDefect = { _, _ -> })

    private fun session(kettle: Kettle = Kettle(), target: String = "app") = kettleApp.openSession(target, kettle, quiet)

    @Test
    fun `a call with an input that is not trusted gives the JSON of its result`() = runBlocking {
        val outcome = session().invoke("kettle.water.fill", buildJsonObject { put("litres", 0.5) })
        assertEquals(Outcome.Completed(Result.Ok(AcidCatJson.encodeToJsonElement(Water.serializer(), Water(20.0, 1.5)))), outcome)
    }

    @Test
    fun `a failure is a result with its tag`() = runBlocking {
        val kettle = Kettle().apply { water.value = Water(20.0, 1.5) }
        val outcome = session(kettle).invoke("kettle.water.fill", buildJsonObject { put("litres", 0.5) })
        val error = ((outcome as Outcome.Completed).result as Result.Failed).error
        assertEquals("Overflow", error.string("_tag"))
    }

    @Test
    fun `an input that does not agree with its schema is invalid-input, and the operation does not start`() = runBlocking {
        val kettle = Kettle()
        val outcome = session(kettle).invoke("kettle.water.fill", buildJsonObject { put("litres", 9) })
        assertEquals(CallFailureKind.InvalidInput, (outcome as Outcome.Failed).failure.kind)
        assertEquals(1.0, kettle.water.value.litres)
        val noInput = session(kettle).invoke("kettle.boil", JsonPrimitive(3))
        assertEquals(CallFailureKind.InvalidInput, (noInput as Outcome.Failed).failure.kind)
    }

    @Test
    fun `an id outside the view is unknown, also when another target has it`() = runBlocking {
        assertEquals(CallFailureKind.UnknownCapability, (session().invoke("kettle.hidden", JsonObject(emptyMap())) as Outcome.Failed).failure.kind)
        assertEquals(CallFailureKind.UnknownCapability, (session().invoke("kettle.nothing", JsonObject(emptyMap())) as Outcome.Failed).failure.kind)
        assertEquals(setOf("kettle.water.fill", "kettle.boil", "kettle.stubborn", "kettle.broken"), session().handles.keys)
    }

    @Test
    fun `an output that does not agree with its schema is a defect, and an internal call failure`() = runBlocking {
        val defects = mutableListOf<String>()
        val session = kettleApp.openSession("app", Kettle(), SessionOptions(onDefect = { id, _ -> defects += id }))
        val outcome = session.invoke("kettle.broken", JsonObject(emptyMap())) as Outcome.Failed
        assertEquals(CallFailure(CallFailureKind.Internal, "The capability failed."), outcome.failure)
        assertEquals(listOf("kettle.broken"), defects)
    }

    @Test
    fun `an unavailable capability is unavailable at the moment of the call`() = runBlocking {
        val kettle = Kettle()
        val session = session(kettle)
        kettle.plugged.value = Availability.Unavailable("The kettle is not plugged in.")
        assertEquals(
            CallFailure(CallFailureKind.Unavailable, "The kettle is not plugged in."),
            (session.invoke("kettle.boil", JsonObject(emptyMap())) as Outcome.Failed).failure,
        )
        assertEquals(false, session.handles.getValue("kettle.boil").availability.value.available)
    }

    @Test
    fun `the cancellation of the caller cancels the call, and only that call`() = runBlocking {
        val kettle = Kettle()
        val session = session(kettle)
        val call = async { session.invoke("kettle.boil", JsonObject(emptyMap())) }
        kettle.started.await()
        val other = session.invoke("kettle.water.fill", buildJsonObject { put("litres", 0.1) })
        assertIs<Outcome.Completed>(other)
        call.cancel()
        withTimeout(5_000) { kettle.cancelled.await() }
        assertTrue(session.isOpen)
    }

    @Test
    fun `close cancels the calls in progress, and they end as cancelled, also when the work ignores the cancellation`() = runBlocking {
        val kettle = Kettle()
        val session = session(kettle)
        val call = async { session.invoke("kettle.stubborn", JsonObject(emptyMap())) }
        kettle.started.await()
        session.close()
        assertEquals(CallFailureKind.Cancelled, (withTimeout(5_000) { call.await() } as Outcome.Failed).failure.kind)
        assertEquals(CallFailureKind.Cancelled, (session.invoke("kettle.water.fill", JsonObject(emptyMap())) as Outcome.Failed).failure.kind)
    }

    @Test
    fun `a typed handle has the types of its capability, and its state`() = runBlocking {
        val kettle = Kettle()
        val session = session(kettle)
        val handle = session.handle(fill)
        assertEquals(Result.Ok(Water(20.0, 1.5)), handle.execute(Fill(0.5)))
        assertEquals(Result.Failed(KettleFailure.Overflow(2.0)), handle.execute(Fill(0.5)))
        assertEquals(Water(20.0, 1.5), handle.snapshot?.first())
        assertEquals(Result.Ok(Water(20.0, 1.6)), session.call(fill, buildJsonObject { put("litres", 0.1) }))
        assertEquals(CallFailureKind.InvalidInput, assertFailsWith<CallFailureException> { session.call(fill, buildJsonObject { put("litres", 0) }) }.kind)
    }

    @Test
    fun `a call failure of a handle throws, and cancelled is a cancellation`() = runBlocking {
        val kettle = Kettle()
        val session = session(kettle)
        val invalid = assertFailsWith<CallFailureException> { session.handles.getValue("kettle.water.fill").invokeExternal(JsonNull) }
        assertEquals(CallFailureKind.InvalidInput, invalid.kind)
        val call = async { runCatching { session.handle(boil).execute(Unit) } }
        kettle.started.await()
        session.close()
        assertIs<CallCancelledException>(call.await().exceptionOrNull())
    }

    @Test
    fun `a capability that the session does not serve has a handle that is always unavailable`() = runBlocking {
        val outside = session().handle(hiddenFromApp)
        assertEquals(false, outside.availability.value.available)
        assertEquals(CallFailureKind.UnknownCapability, assertFailsWith<CallFailureException> { outside.execute(Unit) }.kind)
    }

    @Test
    fun `changes tell when an availability changes`() = runBlocking {
        val kettle = Kettle()
        val session = session(kettle)
        val change = async(start = CoroutineStart.UNDISPATCHED) { session.changes.first() }
        // The flow subscribes to each availability in its own coroutine. The change comes after they subscribe.
        delay(200)
        kettle.plugged.value = Availability.Unavailable("Unplugged.")
        withTimeout(5_000) { change.await() }
    }

    @Test
    fun `the catalog of the application has its capabilities, and the types of their schemas`() {
        val catalog = kettleApp.catalog
        val fillJson = checkNotNull(catalog.obj("capabilities")?.obj("kettle.water.fill"))
        assertEquals(setOf("Empty", "Overflow"), fillJson.obj("failures")?.keys)
        assertEquals("Water", fillJson.obj("state")?.string("title"))
        assertEquals(null, catalog.obj("capabilities")?.obj("kettle.boil")?.get("input"))
        assertEquals(canonicalText(catalog), kettleApp.renderCatalog())
    }

    @Test
    fun `the catalog rejects an audience that is not a target, and an id that is declared two times`() {
        val stranger = capability("kettle.stranger", "Use a target that does not exist.", listOf("nowhere")).run { ok() }
        assertFailsWith<IllegalArgumentException> { App(targets = mapOf("app" to Target(listOf("kotlin"))), capabilities = listOf(stranger)).catalog }
        assertFailsWith<IllegalArgumentException> { App(targets = kettleApp.targets, capabilities = listOf(boil, boil)).catalog }
        assertFailsWith<IllegalArgumentException> { capability("Not an id", "d", listOf("app")) }
    }
}
