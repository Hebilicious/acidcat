/*
 * Schemas: a kotlinx.serialization serializer, and the JSON Schema 2020-12 schema that the catalog gives for it.
 */
package dev.acidcat.core

import io.github.optimumcode.json.schema.JsonSchema
import io.github.optimumcode.json.schema.ValidationError
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerialInfo
import kotlinx.serialization.builtins.serializer
import kotlinx.serialization.descriptors.PolymorphicKind
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.descriptors.SerialKind
import kotlinx.serialization.descriptors.nonNullOriginal
import kotlinx.serialization.descriptors.StructureKind
import kotlinx.serialization.json.Json
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonClassDiscriminator
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.serializer

/**
 * The JSON configuration of AcidCat. A property with a default can be left out. A property that is `null` is left out
 * of the JSON. Unknown members are ignored, as JSON Schema allows them by default. Sealed classes use `_tag` as their
 * discriminator, as failures do (spec/catalog.md#failures).
 */
@OptIn(ExperimentalSerializationApi::class)
public val AcidCatJson: Json = Json {
    explicitNulls = false
    ignoreUnknownKeys = true
    classDiscriminator = "_tag"
    encodeDefaults = true
}

/**
 * A schema: the serializer of a Kotlin type, and its JSON Schema. `json` can refer to the shared types in `types` with
 * `#/$defs/<Name>`. The catalog puts these types in its `$defs`.
 */
public class Schema<T> internal constructor(
    public val serializer: KSerializer<T>,
    public val json: JsonElement,
    public val types: Map<String, JsonElement>,
) {
    /** The schema with its types, for the validator. */
    private val validator: JsonSchema by lazy { JsonSchema.fromDefinition(jsonText(bundle(json, types))) }

    /** The problems of a JSON value with this schema. The list is empty when the value agrees with the schema. */
    public fun problems(value: JsonElement): List<String> {
        val errors = mutableListOf<ValidationError>()
        validator.validate(value, errors::add)
        return errors.map { error ->
            val path = error.objectPath.toString().ifEmpty { "/" }
            "$path: ${error.message}"
        }
    }

    /** Decode a JSON value that agrees with the schema. A value that the serializer cannot read throws. */
    public fun decode(value: JsonElement): T = AcidCatJson.decodeFromJsonElement(serializer, value)

    /** The JSON form of a value. */
    public fun encode(value: T): JsonElement = AcidCatJson.encodeToJsonElement(serializer, value)

    public companion object {
        /** A schema with the JSON Schema that `derive` makes from the serializer. */
        public fun <T> of(serializer: KSerializer<T>): Schema<T> {
            val types = LinkedHashMap<String, JsonElement>()
            val json = SchemaWriter(types).schemaOf(serializer.descriptor, emptyList())
            return Schema(serializer, json, types)
        }

        /** A schema with a JSON Schema that the application writes, and the shared types that it refers to. */
        public fun <T> of(serializer: KSerializer<T>, json: JsonElement, types: Map<String, JsonElement> = emptyMap()): Schema<T> {
            types.keys.forEach { require(isTypeName(it)) { "$it is not a type name. Use [A-Za-z][A-Za-z0-9_]*." } }
            return Schema(serializer, json, types)
        }
    }
}

/** The schema of a Kotlin type, made from its serializer. */
public inline fun <reified T> schemaOf(): Schema<T> = Schema.of(serializer<T>())

/** The schema of a Kotlin type, with a JSON Schema that the application writes. */
public inline fun <reified T> schemaOf(json: JsonElement, types: Map<String, JsonElement> = emptyMap()): Schema<T> =
    Schema.of(serializer<T>(), json, types)

/** The schema of a capability with no input: an empty object. The catalog gives the capability no `input`. */
public val NoInput: Schema<Unit> = Schema(Unit.serializer(), JsonObject(mapOf("type" to JsonPrimitive("object"))), emptyMap())

/** The schema of a capability with no output: the value is `null`. The catalog gives the capability no `output`. */
public val NoOutput: Schema<Unit> = Schema(Unit.serializer(), JsonObject(mapOf("type" to JsonPrimitive("null"))), emptyMap())

/** The description of a type or a property, in its schema. */
@OptIn(ExperimentalSerializationApi::class)
@SerialInfo
@kotlin.annotation.Target(AnnotationTarget.PROPERTY, AnnotationTarget.CLASS)
public annotation class Description(val text: String)

/** Put a class in the `$defs` of the catalog, with its simple name, and refer to it with `$ref`. */
@OptIn(ExperimentalSerializationApi::class)
@SerialInfo
@kotlin.annotation.Target(AnnotationTarget.CLASS)
public annotation class SharedType(val name: String = "")

/** The smallest number that a property accepts: `minimum`. */
@OptIn(ExperimentalSerializationApi::class)
@SerialInfo
@kotlin.annotation.Target(AnnotationTarget.PROPERTY)
public annotation class Minimum(val value: Double)

/** The largest number that a property accepts: `maximum`. */
@OptIn(ExperimentalSerializationApi::class)
@SerialInfo
@kotlin.annotation.Target(AnnotationTarget.PROPERTY)
public annotation class Maximum(val value: Double)

/** The length of a string: `minLength` and `maxLength`. A negative value sets no limit. */
@OptIn(ExperimentalSerializationApi::class)
@SerialInfo
@kotlin.annotation.Target(AnnotationTarget.PROPERTY)
public annotation class Length(val min: Int = -1, val max: Int = -1)

/** The number of items of an array: `minItems` and `maxItems`. A negative value sets no limit. */
@OptIn(ExperimentalSerializationApi::class)
@SerialInfo
@kotlin.annotation.Target(AnnotationTarget.PROPERTY)
public annotation class Items(val min: Int = -1, val max: Int = -1)

/** The regular expression that a string matches: `pattern`. */
@OptIn(ExperimentalSerializationApi::class)
@SerialInfo
@kotlin.annotation.Target(AnnotationTarget.PROPERTY)
public annotation class Pattern(val regex: String)

/** The format of a string: `format`, for example `date-time` or `acidcat-attachment`. */
@OptIn(ExperimentalSerializationApi::class)
@SerialInfo
@kotlin.annotation.Target(AnnotationTarget.PROPERTY)
public annotation class Format(val name: String)

/**
 * Members to add to the schema of a property or a class, as the text of a JSON object, for keywords that have no
 * annotation: `@SchemaMembers("""{ "multipleOf": 0.5 }""")`.
 */
@OptIn(ExperimentalSerializationApi::class)
@SerialInfo
@kotlin.annotation.Target(AnnotationTarget.PROPERTY, AnnotationTarget.CLASS)
public annotation class SchemaMembers(val json: String)

/**
 * Writes the JSON Schema of a serial descriptor. Classes with [SharedType] go into `types`. Each other class gives an
 * inline object schema with its simple name as `title` (spec/catalog.md#types).
 */
@OptIn(ExperimentalSerializationApi::class)
internal class SchemaWriter(private val types: MutableMap<String, JsonElement>) {
    private val writing = mutableSetOf<String>()

    fun schemaOf(descriptor: SerialDescriptor, annotations: List<Annotation>): JsonElement {
        if (descriptor.isNullable) return nullable(schemaOf(descriptor.nonNullOriginal, annotations))
        if (descriptor.isInline) return schemaOf(descriptor.getElementDescriptor(0), annotations + descriptor.getElementAnnotations(0))
        val base = when (descriptor.serialName.removeSuffix("?")) {
            "kotlinx.serialization.json.JsonElement" -> JsonObject(emptyMap())
            "kotlinx.serialization.json.JsonObject" -> objectType()
            "kotlinx.serialization.json.JsonArray" -> JsonObject(mapOf("type" to JsonPrimitive("array")))
            "kotlinx.serialization.json.JsonPrimitive" -> typed(JsonArray(listOf("string", "number", "boolean", "null").map(::JsonPrimitive)))
            "kotlinx.serialization.json.JsonNull" -> typed(JsonPrimitive("null"))
            "kotlin.Unit" -> typed(JsonPrimitive("null"))
            else -> structural(descriptor)
        }
        return withAnnotations(base, annotations)
    }

    private fun structural(descriptor: SerialDescriptor): JsonElement = when (val kind = descriptor.kind) {
        PrimitiveKind.STRING, PrimitiveKind.CHAR -> typed(JsonPrimitive("string"))
        PrimitiveKind.BOOLEAN -> typed(JsonPrimitive("boolean"))
        PrimitiveKind.BYTE, PrimitiveKind.SHORT, PrimitiveKind.INT, PrimitiveKind.LONG -> typed(JsonPrimitive("integer"))
        PrimitiveKind.FLOAT, PrimitiveKind.DOUBLE -> typed(JsonPrimitive("number"))
        SerialKind.ENUM -> JsonObject(
            linkedMapOf(
                "type" to JsonPrimitive("string"),
                "enum" to JsonArray((0 until descriptor.elementsCount).map { JsonPrimitive(descriptor.getElementName(it)) }),
            ),
        )
        StructureKind.LIST -> JsonObject(
            linkedMapOf(
                "type" to JsonPrimitive("array"),
                "items" to schemaOf(descriptor.getElementDescriptor(0), descriptor.getElementAnnotations(0)),
            ),
        )
        StructureKind.MAP -> {
            val key = descriptor.getElementDescriptor(0)
            require(key.kind == PrimitiveKind.STRING || key.kind == SerialKind.ENUM) {
                "${descriptor.serialName}: a JSON object has string keys. Use a map with String keys, or give the schema."
            }
            JsonObject(
                linkedMapOf(
                    "type" to JsonPrimitive("object"),
                    "additionalProperties" to schemaOf(descriptor.getElementDescriptor(1), emptyList()),
                ),
            )
        }
        StructureKind.CLASS, StructureKind.OBJECT -> named(descriptor) { classSchema(descriptor) }
        PolymorphicKind.SEALED -> named(descriptor) { sealedSchema(descriptor) }
        else -> throw IllegalArgumentException(
            "${descriptor.serialName}: the kind $kind has no schema. Give the schema with schemaOf<T>(json).",
        )
    }

    /** The schema of a class, inline with a title, or a reference to a shared type. */
    private fun named(descriptor: SerialDescriptor, write: () -> JsonObject): JsonElement {
        val shared = descriptor.annotations.filterIsInstance<SharedType>().firstOrNull()
            ?: return withClassAnnotations(write(), descriptor, title = simpleName(descriptor))
        val name = shared.name.ifEmpty { simpleName(descriptor) }
        require(isTypeName(name)) { "${descriptor.serialName}: $name is not a type name. Use [A-Za-z][A-Za-z0-9_]*." }
        val reference = JsonObject(mapOf("\$ref" to JsonPrimitive(referenceTo(name))))
        if (name in writing || name in types) return reference
        writing += name
        val schema = withClassAnnotations(write(), descriptor, title = null)
        writing -= name
        val existing = types[name]
        require(existing == null || existing == schema) { "Two different types have the name $name. Give each one its own name." }
        types[name] = schema
        return reference
    }

    private fun classSchema(descriptor: SerialDescriptor): JsonObject {
        val properties = LinkedHashMap<String, JsonElement>()
        val required = mutableListOf<String>()
        for (index in 0 until descriptor.elementsCount) {
            val name = descriptor.getElementName(index)
            val element = descriptor.getElementDescriptor(index)
            // AcidCatJson leaves a null property out, so a nullable property is optional, and null is the same as absent.
            val declared = if (element.isNullable) element.nonNullOriginal else element
            properties[name] = schemaOf(declared, descriptor.getElementAnnotations(index))
            if (!descriptor.isElementOptional(index) && !element.isNullable) required += name
        }
        return JsonObject(
            buildMap {
                put("type", JsonPrimitive("object"))
                put("properties", JsonObject(properties))
                if (required.isNotEmpty()) put("required", JsonArray(required.map(::JsonPrimitive)))
            },
        )
    }

    /** A sealed class: one object schema for each subclass, with the discriminator as a constant. */
    private fun sealedSchema(descriptor: SerialDescriptor): JsonObject {
        val discriminator = descriptor.annotations.filterIsInstance<JsonClassDiscriminator>().firstOrNull()?.discriminator ?: "_tag"
        val subclasses = descriptor.getElementDescriptor(1)
        val members = (0 until subclasses.elementsCount).map { index ->
            val subclass = subclasses.getElementDescriptor(index)
            tagged(schemaOf(subclass, emptyList()), discriminator, subclass.serialName)
        }
        return JsonObject(mapOf("oneOf" to JsonArray(members)))
    }

    private fun simpleName(descriptor: SerialDescriptor): String =
        descriptor.serialName.removeSuffix("?").substringAfterLast('.').substringAfterLast('$')

    private fun withClassAnnotations(schema: JsonObject, descriptor: SerialDescriptor, title: String?): JsonObject {
        val withTitle = if (title != null && "oneOf" !in schema) JsonObject(mapOf("title" to JsonPrimitive(title)) + schema) else schema
        return withAnnotations(withTitle, descriptor.annotations) as JsonObject
    }

    private fun withAnnotations(schema: JsonElement, annotations: List<Annotation>): JsonElement {
        if (annotations.isEmpty() || schema !is JsonObject) return schema
        val members = LinkedHashMap<String, JsonElement>(schema)
        for (annotation in annotations) {
            when (annotation) {
                is Description -> members["description"] = JsonPrimitive(annotation.text)
                is Minimum -> members["minimum"] = number(annotation.value)
                is Maximum -> members["maximum"] = number(annotation.value)
                is Length -> {
                    if (annotation.min >= 0) members["minLength"] = JsonPrimitive(annotation.min)
                    if (annotation.max >= 0) members["maxLength"] = JsonPrimitive(annotation.max)
                }
                is Items -> {
                    if (annotation.min >= 0) members["minItems"] = JsonPrimitive(annotation.min)
                    if (annotation.max >= 0) members["maxItems"] = JsonPrimitive(annotation.max)
                }
                is Pattern -> members["pattern"] = JsonPrimitive(annotation.regex)
                is Format -> members["format"] = JsonPrimitive(annotation.name)
                is SchemaMembers -> {
                    val extra = AcidCatJson.parseToJsonElement(annotation.json) as? JsonObject
                        ?: throw IllegalArgumentException("@SchemaMembers needs the text of a JSON object: ${annotation.json}")
                    members.putAll(extra)
                }
                else -> Unit
            }
        }
        return JsonObject(members)
    }

    private fun typed(type: JsonElement) = JsonObject(mapOf("type" to type))

    private fun objectType() = typed(JsonPrimitive("object"))

    /** A schema that also accepts `null`. */
    private fun nullable(schema: JsonElement): JsonElement {
        val obj = schema as? JsonObject ?: return schema
        val type = obj["type"]
        if (type is JsonPrimitive && type.isString && obj.keys.none { it == "\$ref" || it == "enum" || it == "const" }) {
            return JsonObject(obj + ("type" to JsonArray(listOf(type, JsonPrimitive("null")))))
        }
        return JsonObject(mapOf("anyOf" to JsonArray(listOf(schema, typed(JsonPrimitive("null"))))))
    }

    /** An object schema with a discriminator member whose value is a constant. */
    private fun tagged(schema: JsonElement, discriminator: String, tag: String): JsonElement {
        val obj = resolve(schema, types) as? JsonObject ?: return schema
        val properties = LinkedHashMap<String, JsonElement>()
        properties[discriminator] = JsonObject(linkedMapOf("type" to JsonPrimitive("string"), "const" to JsonPrimitive(tag)))
        properties.putAll(obj.obj("properties").orEmpty())
        val required = listOf(discriminator) + obj.strings("required").filter { it != discriminator }
        return JsonObject(obj + mapOf("properties" to JsonObject(properties), "required" to JsonArray(required.map(::JsonPrimitive))))
    }
}

/** A number in JSON: an integer when the number has no fraction. */
internal fun number(value: Double): JsonPrimitive =
    if (value % 1.0 == 0.0 && kotlin.math.abs(value) < 1e15) JsonPrimitive(value.toLong()) else JsonPrimitive(value)
