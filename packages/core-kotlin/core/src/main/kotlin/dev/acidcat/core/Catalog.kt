/*
 * The fixed details of a catalog (spec/catalog.md): ids, references, bundling, views and the canonical form.
 */
package dev.acidcat.core

import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.booleanOrNull
import kotlinx.serialization.json.doubleOrNull
import kotlinx.serialization.json.jsonPrimitive

/** The version of the specification that a catalog follows. */
public const val ACIDCAT_VERSION: String = "0.1"

private val ID_PATTERN = Regex("^[a-z][a-z0-9]*(-[a-z0-9]+)*(\\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$")
private val REFERENCE = Regex("^#/\\\$defs/([A-Za-z][A-Za-z0-9_]*)$")
private val TYPE_NAME = Regex("^[A-Za-z][A-Za-z0-9_]*$")
private val TARGET_NAME = Regex("^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$")

/** Tell if a text is an id (spec/catalog.md#ids). */
public fun isId(id: String): Boolean = id.length <= 128 && ID_PATTERN.matches(id)

/** Tell if a text is a type name (spec/catalog.md#types). */
public fun isTypeName(name: String): Boolean = TYPE_NAME.matches(name)

/** Tell if a text is a target name (spec/catalog.md#targets). */
public fun isTargetName(name: String): Boolean = TARGET_NAME.matches(name)

/** The name of the type that a reference `#/$defs/<Name>` refers to, or `null` for other text. */
public fun referencedType(reference: String): String? = REFERENCE.matchEntire(reference)?.groupValues?.get(1)

/** The reference to a type: `#/$defs/<Name>`. */
public fun referenceTo(name: String): String = "#/\$defs/$name"

/** A member of an object that is a string, or `null`. */
public fun Map<String, JsonElement>.string(key: String): String? = (this[key] as? JsonPrimitive)?.takeIf { it.isString }?.content

/** A member of an object that is an object, or `null`. */
public fun Map<String, JsonElement>.obj(key: String): JsonObject? = this[key] as? JsonObject

/** The strings of a member that is an array. Other items are left out. */
public fun Map<String, JsonElement>.strings(key: String): List<String> =
    (this[key] as? JsonArray).orEmpty().mapNotNull { (it as? JsonPrimitive)?.takeIf { item -> item.isString }?.content }

/** A member of an object that is a boolean, or `null`. */
public fun Map<String, JsonElement>.boolean(key: String): Boolean? = (this[key] as? JsonPrimitive)?.takeIf { !it.isString }?.booleanOrNull

/** Every object in a JSON value, at all levels. */
public fun visitObjects(value: JsonElement, onObject: (JsonObject) -> Unit) {
    when (value) {
        is JsonArray -> value.forEach { visitObjects(it, onObject) }
        is JsonObject -> {
            onObject(value)
            value.values.forEach { visitObjects(it, onObject) }
        }
        else -> Unit
    }
}

/** The types that a schema uses, directly or through other types, in the order that they are found. */
public fun typesUsedBy(schema: JsonElement, types: Map<String, JsonElement>): Map<String, JsonElement> {
    val used = LinkedHashMap<String, JsonElement>()
    fun collect(node: JsonElement) {
        visitObjects(node) { inner ->
            val name = inner.string("\$ref")?.let(::referencedType) ?: return@visitObjects
            val type = types[name] ?: return@visitObjects
            if (used.containsKey(name)) return@visitObjects
            used[name] = type
            collect(type)
        }
    }
    collect(schema)
    return used
}

/** Resolve a schema that is only a `$ref` to the type that it refers to. Other schemas do not change. */
public fun resolve(schema: JsonElement, types: Map<String, JsonElement>): JsonElement {
    val obj = schema as? JsonObject ?: return schema
    val name = obj.string("\$ref")?.let(::referencedType) ?: return schema
    return types[name] ?: schema
}

/** Bundle a schema (spec/catalog.md#bundling): copy the types that it uses into its own `$defs`. */
public fun bundle(schema: JsonElement, types: Map<String, JsonElement>): JsonElement {
    val obj = schema as? JsonObject ?: return schema
    val only = if (obj.size == 1) obj.string("\$ref")?.let(::referencedType) else null
    val base = only?.let { types[it] } ?: schema
    val used = typesUsedBy(base, types)
    if (used.isEmpty()) return base
    val baseObject = base as? JsonObject ?: return base
    return JsonObject(baseObject + ("\$defs" to JsonObject(used)))
}

/**
 * An input schema that is a union of object schemas, with `"type": "object"`, so that it is an object schema
 * (spec/catalog.md#capabilities). Other schemas do not change.
 */
public fun objectInput(schema: JsonObject, types: Map<String, JsonElement>): JsonObject {
    fun resolveObject(node: JsonElement): JsonObject? = resolve(node, types) as? JsonObject
    val target = resolveObject(schema)
    if (schema.containsKey("type") || target == null || target.containsKey("type")) return schema
    val union = (target["anyOf"] ?: target["oneOf"]) as? JsonArray
    if (union == null || union.isEmpty()) return schema
    val objects = union.all { member -> resolveObject(member)?.string("type") == "object" }
    return if (objects) JsonObject(linkedMapOf<String, JsonElement>("type" to JsonPrimitive("object")) + schema) else schema
}

/** The schemas of a capability of a catalog, each with the member that holds it. */
public fun schemasOf(capability: JsonObject): List<Pair<String, JsonElement>> = buildList {
    for (member in listOf("input", "output", "state")) capability[member]?.let { add(member to it) }
    capability.obj("failures")?.forEach { (tag, schema) -> add("failure $tag" to schema) }
}

/** The view of a target (spec/catalog.md#views). */
public fun viewOf(catalog: JsonObject, target: String): JsonObject {
    val types = catalog.obj("\$defs").orEmpty()
    val capabilities = LinkedHashMap<String, JsonElement>()
    catalog.obj("capabilities").orEmpty().forEach { (id, element) ->
        val capability = element as? JsonObject ?: return@forEach
        if (target !in capability.strings("audience")) return@forEach
        capabilities[id] = JsonObject(capability + ("audience" to JsonArray(listOf(JsonPrimitive(target)))))
    }
    val used = LinkedHashMap<String, JsonElement>()
    capabilities.values.forEach { capability ->
        schemasOf(capability.jsonObjectOrEmpty()).forEach { (_, schema) -> used.putAll(typesUsedBy(schema, types)) }
    }
    val view = LinkedHashMap<String, JsonElement>()
    catalog.forEach { (key, value) ->
        when (key) {
            "\$defs" -> Unit
            "targets" -> view[key] = JsonObject(catalog.obj("targets").orEmpty().filterKeys { it == target })
            "capabilities" -> {
                if (used.isNotEmpty()) view["\$defs"] = JsonObject(used)
                view[key] = JsonObject(capabilities)
            }
            else -> view[key] = value
        }
    }
    return JsonObject(view)
}

private fun JsonElement.jsonObjectOrEmpty(): JsonObject = this as? JsonObject ?: JsonObject(emptyMap())

private val CATALOG_ORDER = listOf("acidcat", "title", "description", "targets", "\$defs", "capabilities")
private val TARGET_ORDER = listOf("bindings", "description", "options")
private val CAPABILITY_ORDER = listOf("description", "audience", "input", "output", "failures", "readOnly", "state")

/** A catalog in canonical form, as text (spec/catalog.md#canonical-form). */
public fun canonicalText(catalog: JsonElement): String = buildString {
    write(canonicalCatalog(catalog), "")
    append('\n')
}

/** Put the members of a catalog in canonical order. */
public fun canonicalCatalog(catalog: JsonElement): JsonElement = ordered(catalog, CATALOG_ORDER) { key, value ->
    when (key) {
        "targets" -> byKey(value) { target -> ordered(target, TARGET_ORDER) { _, inner -> sorted(inner) } }
        "\$defs" -> byKey(value, ::sorted)
        "capabilities" -> byKey(value) { capability ->
            ordered(capability, CAPABILITY_ORDER) { member, inner -> if (member == "failures") byKey(inner, ::sorted) else sorted(inner) }
        }
        else -> sorted(value)
    }
}

/** The known members in their order, then every other member sorted by key. */
private fun ordered(value: JsonElement, order: List<String>, each: (String, JsonElement) -> JsonElement): JsonElement {
    val obj = value as? JsonObject ?: return sorted(value)
    val known = order.filter { it in obj }
    val others = obj.keys.filter { it !in order }.sortedWith(CodePointOrder)
    return JsonObject((known + others).associateWith { key -> each(key, obj.getValue(key)) })
}

/** A map keyed by name or id: its keys sorted, each value shaped by `each`. */
private fun byKey(value: JsonElement, each: (JsonElement) -> JsonElement): JsonElement {
    val obj = value as? JsonObject ?: return sorted(value)
    return JsonObject(obj.keys.sortedWith(CodePointOrder).associateWith { key -> each(obj.getValue(key)) })
}

/** Every object's keys sorted, at every depth. Arrays keep their order. */
private fun sorted(value: JsonElement): JsonElement = when (value) {
    is JsonArray -> JsonArray(value.map(::sorted))
    is JsonObject -> byKey(value, ::sorted)
    else -> value
}

/** Order strings by Unicode code point, as Python, Go and Rust compare them. */
public object CodePointOrder : Comparator<String> {
    override fun compare(a: String, b: String): Int {
        var i = 0
        var j = 0
        while (i < a.length && j < b.length) {
            val left = a.codePointAt(i)
            val right = b.codePointAt(j)
            if (left != right) return left.compareTo(right)
            i += Character.charCount(left)
            j += Character.charCount(right)
        }
        return (a.length - i).compareTo(b.length - j)
    }
}

/** Write a JSON value with two-space indentation, one member or item on each line. */
private fun StringBuilder.write(value: JsonElement, indent: String) {
    when (value) {
        is JsonArray -> {
            if (value.isEmpty()) return run { append("[]") }
            val inner = "$indent  "
            append("[\n")
            value.forEachIndexed { index, item ->
                append(inner)
                write(item, inner)
                append(if (index == value.size - 1) "\n" else ",\n")
            }
            append(indent).append(']')
        }
        is JsonObject -> {
            if (value.isEmpty()) return run { append("{}") }
            val inner = "$indent  "
            append("{\n")
            value.entries.forEachIndexed { index, (key, item) ->
                append(inner).append(jsonString(key)).append(": ")
                write(item, inner)
                append(if (index == value.size - 1) "\n" else ",\n")
            }
            append(indent).append('}')
        }
        is JsonNull -> append("null")
        is JsonPrimitive -> append(jsonText(value))
    }
}

/** The text of a JSON value on one line, as `JSON.stringify` in ECMAScript writes it. */
public fun jsonText(value: JsonElement): String = when (value) {
    is JsonNull -> "null"
    is JsonPrimitive -> when {
        value.isString -> jsonString(value.content)
        value.booleanOrNull != null -> value.content
        else -> ecmaScriptNumber(value.doubleOrNull ?: throw IllegalArgumentException("${value.content} is not a JSON number"))
    }
    is JsonArray -> value.joinToString(",", "[", "]") { jsonText(it) }
    is JsonObject -> value.entries.joinToString(",", "{", "}") { (key, item) -> "${jsonString(key)}:${jsonText(item)}" }
}

/** A string as `JSON.stringify` writes it: only `"`, `\`, control characters and lone surrogates are escaped. */
public fun jsonString(text: String): String = buildString {
    append('"')
    var index = 0
    while (index < text.length) {
        val char = text[index]
        when {
            char == '"' -> append("\\\"")
            char == '\\' -> append("\\\\")
            char == '\b' -> append("\\b")
            char == '\u000C' -> append("\\f")
            char == '\n' -> append("\\n")
            char == '\r' -> append("\\r")
            char == '\t' -> append("\\t")
            char < ' ' -> append("\\u").append(char.code.toString(16).padStart(4, '0'))
            char.isHighSurrogate() && index + 1 < text.length && text[index + 1].isLowSurrogate() -> {
                append(char).append(text[index + 1])
                index += 1
            }
            char.isSurrogate() -> append("\\u").append(char.code.toString(16).padStart(4, '0'))
            else -> append(char)
        }
        index += 1
    }
    append('"')
}

/**
 * A number as `Number.prototype.toString` in ECMAScript writes it: the shortest digits that give the same double, with
 * an exponent only below 1e-6 or from 1e21.
 */
public fun ecmaScriptNumber(number: Double): String {
    require(number.isFinite()) { "A catalog holds only finite numbers" }
    if (number == 0.0) return "0"
    if (number < 0) return "-" + ecmaScriptNumber(-number)
    val (digits, point) = shortestDigits(number)
    val k = digits.length
    return when {
        point in k..21 -> digits + "0".repeat(point - k)
        point in 1..21 -> digits.substring(0, point) + "." + digits.substring(point)
        point in -5..0 -> "0." + "0".repeat(-point) + digits
        else -> {
            val e = point - 1
            val sign = if (e >= 0) "+" else "-"
            val head = if (k == 1) digits else digits[0] + "." + digits.substring(1)
            "${head}e$sign${kotlin.math.abs(e)}"
        }
    }
}

/**
 * The fewest significant digits that give the same double, rounded to the closest, and the position of the decimal
 * point after the first digit: the number is `0.digits × 10^point`.
 */
private fun shortestDigits(number: Double): Pair<String, Int> {
    for (precision in 0..16) {
        val text = String.format(java.util.Locale.ROOT, "%.${precision}e", number)
        if (text.toDouble() != number) continue
        val mantissa = text.substringBefore('e').replace(".", "")
        val exponent = text.substringAfter('e').toInt()
        return mantissa.trimEnd('0') to exponent + 1
    }
    throw IllegalStateException("$number has no decimal form with 17 digits.")
}
