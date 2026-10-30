/*
 * The JSON of the parameters and the return values of the generated app functions.
 */
package dev.acidcat.appfunctions

import androidx.appfunctions.AppFunctionInvalidArgumentException
import dev.acidcat.core.AcidCatJson
import kotlinx.serialization.KSerializer
import kotlinx.serialization.SerializationException
import kotlinx.serialization.builtins.ListSerializer
import kotlinx.serialization.descriptors.PrimitiveKind
import kotlinx.serialization.descriptors.PrimitiveSerialDescriptor
import kotlinx.serialization.descriptors.SerialDescriptor
import kotlinx.serialization.encoding.Decoder
import kotlinx.serialization.encoding.Encoder
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonDecoder
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonEncoder
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** Builds the input of a call from the parameters of an app function. A parameter that is `null` is left out. */
public class InputBuilder internal constructor() {
    private val members = LinkedHashMap<String, JsonElement>()

    public fun put(name: String, value: String?) {
        if (value != null) members[name] = JsonPrimitive(value)
    }

    public fun put(name: String, value: Long?) {
        if (value != null) members[name] = JsonPrimitive(value)
    }

    public fun put(name: String, value: Double?) {
        if (value != null) members[name] = JsonPrimitive(value)
    }

    public fun put(name: String, value: Boolean?) {
        if (value != null) members[name] = JsonPrimitive(value)
    }

    public fun put(name: String, value: LongArray?) {
        if (value != null) members[name] = JsonArray(value.map(::JsonPrimitive))
    }

    public fun put(name: String, value: DoubleArray?) {
        if (value != null) members[name] = JsonArray(value.map(::JsonPrimitive))
    }

    public fun put(name: String, value: BooleanArray?) {
        if (value != null) members[name] = JsonArray(value.map(::JsonPrimitive))
    }

    public fun put(name: String, value: List<String>?) {
        if (value != null) members[name] = JsonArray(value.map(::JsonPrimitive))
    }

    /** A parameter of a generated type. */
    public fun <T> put(name: String, value: T?, serializer: KSerializer<T>) {
        if (value != null) members[name] = encoded(name) { AcidCatJson.encodeToJsonElement(serializer, value) }
    }

    /** A parameter that is a list of a generated type. */
    public fun <T> putList(name: String, value: List<T>?, serializer: KSerializer<T>) {
        if (value != null) members[name] = encoded(name) { AcidCatJson.encodeToJsonElement(ListSerializer(serializer), value) }
    }

    /** A parameter that holds JSON text. Text that is not JSON is an invalid argument. */
    public fun putJson(name: String, text: String?) {
        if (text != null) members[name] = parsed(name, text)
    }

    /** The input of a capability whose input schema has no `properties` member: the JSON text of the whole input. */
    public fun putAll(text: String) {
        val input = parsed("input", text) as? JsonObject ?: throw AppFunctionInvalidArgumentException("input: the input must be a JSON object.")
        members.putAll(input)
    }

    internal fun build(): JsonObject = JsonObject(members)

    private inline fun encoded(name: String, encode: () -> JsonElement): JsonElement = try {
        encode()
    } catch (cause: SerializationException) {
        throw AppFunctionInvalidArgumentException("$name: ${cause.message}")
    }

    private fun parsed(name: String, text: String): JsonElement = try {
        AcidCatJson.parseToJsonElement(text)
    } catch (_: SerializationException) {
        throw AppFunctionInvalidArgumentException("$name: the value is not JSON text.")
    }
}

/** The input of a call, from the parameters of an app function. */
public fun input(build: InputBuilder.() -> Unit): JsonObject = InputBuilder().apply(build).build()

/** A value of a generated type, from its JSON. */
public fun <T> decode(serializer: KSerializer<T>, value: JsonElement): T = try {
    AcidCatJson.decodeFromJsonElement(serializer, value)
} catch (cause: SerializationException) {
    throw IllegalArgumentException("The value does not fit the generated type: ${cause.message}", cause)
}

/** A value as JSON text, for a return value that holds JSON text. */
public fun jsonTextOf(value: JsonElement): String = dev.acidcat.core.jsonText(value)

/**
 * The serializer of a property that holds JSON text. In JSON, the property is the JSON value of the text, not a string.
 * Text that is not JSON cannot be encoded.
 */
public object JsonText : KSerializer<String> {
    override val descriptor: SerialDescriptor = PrimitiveSerialDescriptor("dev.acidcat.appfunctions.JsonText", PrimitiveKind.STRING)

    override fun serialize(encoder: Encoder, value: String) {
        val json = encoder as? JsonEncoder ?: throw SerializationException("JSON text needs the JSON format.")
        json.encodeJsonElement(AcidCatJson.parseToJsonElement(value))
    }

    override fun deserialize(decoder: Decoder): String {
        val json = decoder as? JsonDecoder ?: throw SerializationException("JSON text needs the JSON format.")
        return dev.acidcat.core.jsonText(json.decodeJsonElement())
    }
}
