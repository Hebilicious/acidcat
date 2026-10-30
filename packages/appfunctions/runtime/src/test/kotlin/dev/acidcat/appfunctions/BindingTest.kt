package dev.acidcat.appfunctions

import androidx.appfunctions.AppFunctionAppUnknownException
import androidx.appfunctions.AppFunctionCancelledException
import androidx.appfunctions.AppFunctionDisabledException
import androidx.appfunctions.AppFunctionFunctionNotFoundException
import androidx.appfunctions.AppFunctionInvalidArgumentException
import dev.acidcat.core.App
import dev.acidcat.core.Availability
import dev.acidcat.core.CallFailure
import dev.acidcat.core.CallFailureKind
import dev.acidcat.core.SessionOptions
import dev.acidcat.core.Target
import dev.acidcat.core.capabilitiesFor
import dev.acidcat.core.fail
import dev.acidcat.core.ok
import kotlinx.coroutines.flow.MutableStateFlow
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.jsonPrimitive
import org.junit.Test
import org.junit.runner.RunWith
import org.robolectric.RobolectricTestRunner
import org.robolectric.annotation.Config
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertIs

@Serializable
data class Note(val title: String, @Serializable(with = JsonText::class) val extra: String? = null)

@Serializable
sealed interface NoteFailure {
    @Serializable
    @SerialName("Missing")
    data class Missing(val title: String) : NoteFailure
}

@RunWith(RobolectricTestRunner::class)
@Config(sdk = [36])
class BindingTest {
    private val open = MutableStateFlow<Availability>(Availability.Available)
    private val capability = capabilitiesFor<Unit>()
    private val app = App(
        targets = mapOf("android" to Target(listOf("appfunctions"))),
        capabilities = listOf(
            capability("notes.note.get", "Get a note.", listOf("android"))
                .input<Note>()
                .output<Note>()
                .failures<NoteFailure>()
                .availability { open }
                .run { input -> if (input.title == "none") fail(NoteFailure.Missing(input.title)) else ok(input) },
            capability("notes.crash", "Fail with a defect.", listOf("android")).run { error("secret") },
        ),
    )
    private val binding = AppFunctionsBinding(app, "android", Unit, SessionOptions(onDefect = { _, _ -> }))

    private suspend fun get(title: Any?): String = binding.call(
        "notes.note.get",
        input { if (title is String) put("title", title) else put("title", (title as Number).toLong()) },
        value = { (it as JsonObject).getValue("title").jsonPrimitive.content },
        failure = { "failure ${it.getValue("_tag").jsonPrimitive.content}" },
    )

    @Test
    fun `a value and a failure are return values`() = runBlocking {
        assertEquals("a", get("a"))
        assertEquals("failure Missing", get("none"))
    }

    @Test
    fun `each call failure is the exception of its kind`() = runBlocking {
        assertFailsWith<AppFunctionInvalidArgumentException> { get(5) }
        open.value = Availability.Unavailable("Closed.")
        assertFailsWith<AppFunctionDisabledException> { get("a") }
        assertFailsWith<AppFunctionFunctionNotFoundException> { binding.call("notes.nothing", input {}, value = {}) }
        assertFailsWith<AppFunctionAppUnknownException> { binding.call("notes.crash", input {}, value = {}) }
        Unit
    }

    @Test
    fun `the kinds map to the exceptions of AppFunctions`() {
        assertIs<AppFunctionCancelledException>(CallFailure(CallFailureKind.Cancelled, "m").toAppFunctionException())
        assertIs<AppFunctionFunctionNotFoundException>(CallFailure(CallFailureKind.UnknownCapability, "m").toAppFunctionException())
        assertIs<AppFunctionDisabledException>(CallFailure(CallFailureKind.Unavailable, "m").toAppFunctionException())
        assertIs<AppFunctionInvalidArgumentException>(CallFailure(CallFailureKind.InvalidInput, "m").toAppFunctionException())
        assertIs<AppFunctionAppUnknownException>(CallFailure(CallFailureKind.Internal, "m").toAppFunctionException())
    }

    @Test
    fun `the input leaves out null parameters, and reads JSON text`() {
        val built = input {
            put("a", "text")
            put("b", null as String?)
            put("c", longArrayOf(1, 2))
            putJson("d", """{"x":[1,2]}""")
            put("e", Note("t", """{"y":true}"""), Note.serializer())
        }
        assertEquals("""{"a":"text","c":[1,2],"d":{"x":[1,2]},"e":{"title":"t","extra":{"y":true}}}""", built.toString())
        assertFailsWith<AppFunctionInvalidArgumentException> { input { putJson("d", "not json") } }
        assertFailsWith<AppFunctionInvalidArgumentException> { input { putAll("[1]") } }
    }

    @Test
    fun `a value of a generated type comes from its JSON, and JSON text keeps a value`() {
        val note = decode(Note.serializer(), dev.acidcat.core.AcidCatJson.parseToJsonElement("""{"title":"t","extra":{"z":null}}"""))
        assertEquals(Note("t", """{"z":null}"""), note)
        assertEquals("[1,\"a\"]", jsonTextOf(dev.acidcat.core.AcidCatJson.parseToJsonElement("[1, \"a\"]")))
        assertEquals("text", decode(String.serializer(), JsonPrimitive("text")))
        assertFailsWith<IllegalArgumentException> { decode(Long.serializer(), JsonPrimitive("text")) }
    }
}
