package dev.acidcat.core

import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.test.Test
import kotlin.test.assertEquals

class CatalogTest {
    private fun resource(name: String): String = checkNotNull(javaClass.getResource("/$name")).readText()

    @Test
    fun `the canonical form is the text that the TypeScript catalog library writes, byte for byte`() {
        // edge.acidcat.json is the output of `acid-cat format` for edge.input.json.
        val catalog = AcidCatJson.parseToJsonElement(resource("edge.input.json"))
        assertEquals(resource("edge.acidcat.json"), canonicalText(catalog))
    }

    @Test
    fun `numbers are written as ECMAScript writes them`() {
        val cases = mapOf(
            0.0 to "0", 16.0 to "16", 0.5 to "0.5", 1e-7 to "1e-7", 1e21 to "1e+21", 1e20 to "100000000000000000000",
            123.456 to "123.456", 0.000001 to "0.000001", -2.5 to "-2.5", 5e-324 to "5e-324", 1.7976931348623157e308 to "1.7976931348623157e+308",
            0.1 + 0.2 to "0.30000000000000004", 123456789012.0 to "123456789012", 1.5e-10 to "1.5e-10",
        )
        cases.forEach { (number, text) -> assertEquals(text, ecmaScriptNumber(number), "the text of $number") }
    }

    @Test
    fun `strings escape only quotes, backslashes, control characters and lone surrogates`() {
        assertEquals("\"a\\\"b\\\\c\\n\\u0001é😀\\ud800\"", jsonString("a\"b\\c\n\u0001é😀\ud800"))
    }

    @Test
    fun `a view has only the target, its capabilities and the types that they use`() {
        val catalog = AcidCatJson.parseToJsonElement(
            """{ "acidcat": "0.1", "targets": { "a": { "bindings": ["http"] }, "b": { "bindings": ["cli"] } },
                 "${'$'}defs": { "Used": { "type": "object", "properties": { "x": { "${'$'}ref": "#/${'$'}defs/Deep" } } }, "Deep": { "type": "string" }, "Unused": { "type": "string" } },
                 "capabilities": {
                   "x.one": { "description": "d", "audience": ["a", "b"], "output": { "${'$'}ref": "#/${'$'}defs/Used" } },
                   "x.two": { "description": "d", "audience": ["b"], "output": { "${'$'}ref": "#/${'$'}defs/Unused" } } } }""",
        ) as JsonObject
        val view = viewOf(catalog, "a")
        assertEquals(setOf("a"), view.obj("targets")?.keys)
        assertEquals(setOf("x.one"), view.obj("capabilities")?.keys)
        assertEquals(listOf("a"), view.obj("capabilities")?.obj("x.one")?.strings("audience"))
        assertEquals(setOf("Used", "Deep"), view.obj("\$defs")?.keys)
        val bundled = bundle(checkNotNull(view.obj("capabilities")?.obj("x.one")?.get("output")), view.obj("\$defs").orEmpty()) as JsonObject
        assertEquals(JsonPrimitive("object"), bundled["type"])
        assertEquals(setOf("Deep"), bundled.obj("\$defs")?.keys)
    }

    @Test
    fun `ids, type names and target names have their forms`() {
        assertEquals(true, isId("aircon.power.set"))
        assertEquals(true, isId("fan-speed.set"))
        assertEquals(false, isId("aircon"))
        assertEquals(false, isId("Aircon.power"))
        assertEquals(true, isTypeName("Status_2"))
        assertEquals(false, isTypeName("2Status"))
        assertEquals(true, isTargetName("acme:panel"))
    }
}
