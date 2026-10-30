package dev.acidcat.appfunctions.gradle

import dev.acidcat.core.AcidCatJson
import kotlinx.serialization.json.JsonObject
import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertNull
import kotlin.test.assertTrue

class GeneratorTest {
    private val expected = File(System.getProperty("acidcat.expected"))
    private val update = System.getProperty("acidcat.update") == "true"

    private fun catalog(property: String): JsonObject =
        AcidCatJson.parseToJsonElement(File(System.getProperty(property)).readText()) as JsonObject

    /** Compare each generated file with its expected file. With `-Dacidcat.update=true`, write the expected files. */
    private fun assertGenerated(name: String, generated: Generated) {
        val files = generated.sources.mapKeys { (path, _) -> path.substringAfterLast('/') } +
            mapOf("AndroidManifest.xml" to generated.manifest) +
            (generated.appMetadata?.let { mapOf("acidcat_app_metadata.xml" to it) } ?: emptyMap())
        val directory = expected.resolve(name)
        if (update) {
            directory.deleteRecursively()
            directory.mkdirs()
            files.forEach { (file, text) -> directory.resolve(file).writeText(text) }
        }
        assertEquals(directory.list().orEmpty().sorted(), files.keys.sorted(), "the generated files of $name")
        files.forEach { (file, text) -> assertEquals(directory.resolve(file).readText(), text, "$name/$file") }
    }

    @Test
    fun `the app functions of the fixture are the expected files`() {
        val settings = GeneratorSettings("android", "dev.acidcat.fixture.android.functions", "FixtureAppFunctionService", "dev.acidcat.fixture.android.FixtureProvider")
        assertGenerated("fixture", generate(catalog("acidcat.fixture"), settings))
    }

    @Test
    fun `the app functions of the shapes are the expected files`() {
        val settings = GeneratorSettings("android", "dev.acidcat.shapes.functions", "ShapesAppFunctionService", "dev.acidcat.shapes.ShapesProvider")
        assertGenerated("shapes", generate(catalog("acidcat.shapes"), settings))
    }

    @Test
    fun `a function name comes from the id, and two ids never give the same name`() {
        assertEquals("aircon_power_set", functionName("aircon.power.set"))
        assertEquals("fan__speed_set", functionName("fan-speed.set"))
        assertEquals("a__b_c", functionName("a-b.c"))
        assertEquals("a_b__c", functionName("a.b-c"))
    }

    @Test
    fun `a property name becomes a Kotlin identifier`() {
        assertEquals("speed", propertyName("speed"))
        assertEquals("max_speed", propertyName("max-speed"))
        assertEquals("_2fast", propertyName("2fast"))
        assertEquals("in_", propertyName("in"))
        assertEquals("_tag", propertyName("_tag"))
    }

    @Test
    fun `the generator stops when two properties give the same identifier`() {
        val catalog = catalogOf(
            """{ "x.y": { "description": "d", "audience": ["android"], "input": { "type": "object", "properties": { "a-b": {}, "a_b": {} } } } }""",
        )
        val error = assertFailsWith<IllegalStateException> { generate(catalog, GeneratorSettings("android", "p", "S", "P")) }
        assertTrue("a_b" in error.message.orEmpty())
    }

    @Test
    fun `the generator stops when two tags give the same property`() {
        val catalog = catalogOf(
            """{ "x.y": { "description": "d", "audience": ["android"], "failures": {
                "Off-line": { "type": "object", "properties": { "_tag": { "const": "Off-line" }, "a": {} } },
                "OffLine": { "type": "object", "properties": { "_tag": { "const": "OffLine" }, "a": {} } } } } }""",
        )
        assertFailsWith<IllegalStateException> { generate(catalog, GeneratorSettings("android", "p", "S", "P")) }
    }

    @Test
    fun `a catalog with no description has no app metadata`() {
        val generated = generate(catalogOf("""{ "x.y": { "description": "d", "audience": ["android"] } }"""), GeneratorSettings("android", "p", "S", "P"))
        assertNull(generated.appMetadata)
        assertTrue("app_metadata" !in generated.manifest)
    }

    @Test
    fun `the target must be in the catalog`() {
        assertFailsWith<IllegalArgumentException> { generate(catalogOf("{}"), GeneratorSettings("missing", "p", "S", "P")) }
    }

    private fun catalogOf(capabilities: String): JsonObject = AcidCatJson.parseToJsonElement(
        """{ "acidcat": "0.1", "targets": { "android": { "bindings": ["appfunctions"] } }, "capabilities": $capabilities }""",
    ) as JsonObject
}
