package dev.acidcat.core

import kotlinx.serialization.SerialName
import kotlinx.serialization.Serializable
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertFailsWith
import kotlin.test.assertTrue

@Serializable
@SharedType
@Description("A point on the map.")
data class Point(val latitude: Double, val longitude: Double)

@Serializable
enum class Speed {
    @SerialName("low")
    Low,

    @SerialName("high")
    High,
}

@Serializable
data class Settings(
    @Minimum(16.0) @Maximum(31.0) @Description("The target temperature.") val celsius: Double,
    val speed: Speed = Speed.Low,
    @Length(min = 1, max = 20) val label: String? = null,
    @Items(max = 3) val points: List<Point> = emptyList(),
    val extra: Map<String, Int> = emptyMap(),
    @SchemaMembers("""{ "multipleOf": 5 }""") val count: Int,
)

@Serializable
sealed interface Shape {
    @Serializable
    @SerialName("circle")
    data class Circle(val radius: Double) : Shape

    @Serializable
    @SerialName("square")
    data class Square(val side: Double) : Shape
}

class SchemaTest {
    private fun text(schema: Schema<*>): String = canonicalText(schema.json)

    @Test
    fun `a class gives an object schema with a title, its required properties and its annotations`() {
        val schema = schemaOf<Settings>()
        val json = schema.json as JsonObject
        assertEquals("Settings", json.string("title"))
        assertEquals("object", json.string("type"))
        assertEquals(listOf("celsius", "count"), json.strings("required"))
        val properties = checkNotNull(json.obj("properties"))
        assertEquals(
            """{"description":"The target temperature.","maximum":31,"minimum":16,"type":"number"}""",
            jsonText(canonicalCatalog(checkNotNull(properties["celsius"]))),
        )
        assertEquals("""{"enum":["low","high"],"type":"string"}""", jsonText(canonicalCatalog(checkNotNull(properties["speed"]))))
        // A nullable property is optional, and null is the same as absent.
        assertEquals("""{"maxLength":20,"minLength":1,"type":"string"}""", jsonText(canonicalCatalog(checkNotNull(properties["label"]))))
        assertEquals("""{"multipleOf":5,"type":"integer"}""", jsonText(canonicalCatalog(checkNotNull(properties["count"]))))
        assertEquals("""{"additionalProperties":{"type":"integer"},"type":"object"}""", jsonText(canonicalCatalog(checkNotNull(properties["extra"]))))
    }

    @Test
    fun `a shared type goes into the types, and the schema refers to it`() {
        val schema = schemaOf<Settings>()
        val points = (schema.json as JsonObject).obj("properties")?.obj("points")
        assertEquals("""{"items":{"${'$'}ref":"#/${'$'}defs/Point"},"maxItems":3,"type":"array"}""", jsonText(canonicalCatalog(checkNotNull(points))))
        assertEquals(setOf("Point"), schema.types.keys)
        assertEquals("A point on the map.", (schema.types["Point"] as JsonObject).string("description"))
    }

    @Test
    fun `a sealed class gives one object schema for each subclass, with its tag`() {
        val schema = schemaOf<Shape>()
        assertTrue("\"_tag\"" in text(schema))
        assertTrue("\"const\": \"circle\"" in text(schema))
        assertEquals(emptyList(), schema.problems(schema.encode(Shape.Circle(2.0))))
    }

    @Test
    fun `a value that does not agree with the schema has problems`() {
        val schema = schemaOf<Settings>()
        assertTrue(schema.problems(AcidCatJson.parseToJsonElement("""{ "celsius": 40, "count": 5 }""")).isNotEmpty())
        assertTrue(schema.problems(AcidCatJson.parseToJsonElement("""{ "celsius": 20 }""")).isNotEmpty())
        assertEquals(emptyList(), schema.problems(AcidCatJson.parseToJsonElement("""{ "celsius": 20, "count": 5 }""")))
        assertEquals(Settings(celsius = 20.0, count = 5), schema.decode(AcidCatJson.parseToJsonElement("""{ "celsius": 20, "count": 5 }""")))
    }

    @Test
    fun `failures are a sealed class, and each schema has its tag`() {
        val failures = failuresOf<Shape>()
        assertEquals(setOf("circle", "square"), failures.schemas.keys)
        val circle = failures.schemas.getValue("circle") as JsonObject
        assertEquals(listOf("_tag", "radius"), circle.strings("required"))
    }

    @Test
    fun `failures need a sealed class`() {
        assertFailsWith<IllegalArgumentException> { failuresOf<Point>() }
    }
}
