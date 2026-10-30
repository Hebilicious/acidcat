/*
 * Generate the AppFunctions service of a target from its view (spec/bindings/appfunctions.md). The generated code is
 * Kotlin that the AppFunctions compiler (KSP) reads: one `@AppFunctionDeclaration` for each capability, and one
 * `@AppFunctionSerializable` class for each object type.
 */
package dev.acidcat.appfunctions.gradle

import dev.acidcat.core.bundle
import dev.acidcat.core.obj
import dev.acidcat.core.referencedType
import dev.acidcat.core.resolve
import dev.acidcat.core.string
import dev.acidcat.core.strings
import dev.acidcat.core.viewOf
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive

/** The settings of the generator. */
public class GeneratorSettings(
    /** The target whose view the app functions serve. */
    public val target: String,
    /** The package of the generated code. */
    public val packageName: String,
    /** The name of the service class that the AppFunctions compiler generates, for example `TodoAppFunctionService`. */
    public val serviceName: String,
    /** The fully qualified name of the `object` that implements `dev.acidcat.appfunctions.AppFunctionsProvider`. */
    public val provider: String,
) {
    /** The abstract class that declares the app functions. The function identifiers start with its name. */
    public val baseName: String get() = "${serviceName}Base"

    /** The name of the XML file of the app functions, in the assets of the app. */
    public val xmlFileName: String get() = snakeCase(serviceName)

    /** The name of the generated object that has the function identifier of each capability. */
    public val functionsName: String get() = "${serviceName}Functions"
}

/** The generated files: Kotlin sources by path, the app metadata resource, and the manifest. */
public class Generated(
    public val sources: Map<String, String>,
    /** The XML resource `res/xml/acidcat_app_metadata.xml`, or `null` when the catalog has no description. */
    public val appMetadata: String?,
    public val manifest: String,
)

/** The name of the app function of a capability (spec/bindings/appfunctions.md#names): `.` gives `_`, and `-` gives `__`. */
public fun functionName(id: String): String = id.replace("-", "__").replace(".", "_")

/** Generate the app functions of the view of a target of a catalog. */
public fun generate(catalog: JsonObject, settings: GeneratorSettings): Generated {
    require(settings.target in catalog.obj("targets").orEmpty()) { "The catalog has no target ${settings.target}." }
    val view = viewOf(catalog, settings.target)
    return Writer(view, settings).write()
}

/** A Kotlin type of a parameter, a property or a return value, and how it goes to and from JSON. */
private sealed interface KotlinType {
    val text: String

    /** A type that kotlinx.serialization reads and writes as the JSON of the schema. */
    data class Plain(override val text: String, val constraint: String? = null) : KotlinType

    /** A generated class. */
    data class Generated(val name: String) : KotlinType {
        override val text: String get() = name
    }

    /** A list of a generated class. */
    data class ListOf(val name: String) : KotlinType {
        override val text: String get() = "List<$name>"
    }

    /** A string that holds the JSON text of a value, for a schema that the types of AppFunctions cannot hold. */
    data object Json : KotlinType {
        override val text: String get() = "String"
    }
}

/** A property of an object schema, as a parameter of a function or a property of a class. */
private class Member(
    val json: String,
    val kotlin: String,
    val type: KotlinType,
    val required: Boolean,
    val description: String?,
)

/**
 * A generated class: its name, its description, and its properties. A class of a schema is also serializable with
 * kotlinx.serialization, so that it goes to and from the JSON of the schema. `schema` is `null` for the result and the
 * failure of a capability, which the generated code makes itself.
 */
private class GeneratedClass(val name: String, val description: String?, val members: List<Member>, val schema: JsonElement?)

private class Writer(private val view: JsonObject, private val settings: GeneratorSettings) {
    private val types: Map<String, JsonElement> = view.obj("\$defs").orEmpty()
    private val classes = LinkedHashMap<String, GeneratedClass>()
    private val wantedNames = mutableMapOf<String, String>()

    fun write(): Generated {
        val capabilities = view.obj("capabilities").orEmpty()
        val functions = capabilities.entries.sortedBy { it.key }.map { (id, capability) -> function(id, capability as JsonObject) }
        val names = functions.map { it.name }
        check(names.toSet().size == names.size) { "Two capabilities give the same function name." }
        return Generated(
            sources = mapOf(
                "${settings.packageName.replace('.', '/')}/${settings.baseName}.kt" to service(functions),
                "${settings.packageName.replace('.', '/')}/${settings.functionsName}.kt" to functionsObject(functions),
                "${settings.packageName.replace('.', '/')}/${settings.serviceName}Types.kt" to typesFile(),
            ),
            appMetadata = view.string("description")?.let(::appMetadata),
            manifest = manifest(),
        )
    }

    // -----------------------------------------------------------------------------------------------------------
    // Functions
    // -----------------------------------------------------------------------------------------------------------

    private class Function(val id: String, val name: String, val source: String)

    private fun function(id: String, capability: JsonObject): Function {
        val name = functionName(id)
        val base = pascalCase(id)
        val description = capability.string("description").orEmpty()
        val input = capability["input"]?.let { resolvedObject(it) }
        val parameters: List<Member>
        val wholeInput: Boolean
        if (input != null && "properties" !in input) {
            // An input schema with no `properties` member takes any object: one parameter with the JSON text of the input.
            parameters = listOf(Member("input", "input", KotlinType.Json, true, "The input, as the text of a JSON object."))
            wholeInput = true
        } else {
            parameters = members(input, "${base}Input")
            wholeInput = false
        }
        val output = capability["output"]
        val valueType = output?.let { typeOf(it, "${base}Output") }
        // A value that can be null has a nullable type. JSON text holds null as the text `null`.
        val nullableValue = output != null && valueType !is KotlinType.Json && acceptsNull(output)
        val value = valueType?.let { if (nullableValue) "if (it is JsonNull) null else ${fromJson(it, "it")}" else fromJson(it, "it") }
        val failures = capability.obj("failures").orEmpty()

        val returnType: String
        val valueLambda: String
        val failureLambda: String?
        if (failures.isEmpty()) {
            returnType = valueType?.let { if (nullableValue) "${it.text}?" else it.text } ?: "Unit"
            valueLambda = value ?: ""
            failureLambda = null
        } else {
            val result = resultClass(base, valueType, failures)
            returnType = result.first
            valueLambda = if (value == null) "$returnType(ok = true)" else "$returnType(ok = true, value = $value)"
            failureLambda = "$returnType(ok = false, error = ${result.second}(it))"
        }

        val source = buildString {
            append(kdoc(description, parameters.map { it.kotlin to it.description }, indent = "    "))
            append("    @AppFunctionDeclaration(isDescribedByKDoc = true)\n")
            append("    public suspend fun $name(")
            if (parameters.isNotEmpty()) {
                append('\n')
                parameters.forEach { member ->
                    append("        ")
                    constraintOf(member.type)?.let { append(it).append(' ') }
                    append(identifier(member.kotlin)).append(": ").append(member.type.text)
                    if (!member.required) append("? = null")
                    append(",\n")
                }
                append("    ")
            }
            append("): $returnType =\n")
            append("        binding.call(\n")
            append("            id = ${literal(id)},\n")
            when {
                wholeInput -> append("            input = input { putAll(input) },\n")
                parameters.isEmpty() -> append("            input = input {},\n")
                else -> {
                    append("            input = input {\n")
                    parameters.forEach { append("                ${toJson(it)}\n") }
                    append("            },\n")
                }
            }
            append(if (valueLambda.isEmpty()) "            value = {},\n" else "            value = { $valueLambda },\n")
            if (failureLambda != null) append("            failure = { $failureLambda },\n")
            append("        )\n")
        }
        return Function(id, name, source)
    }

    /** The class of the result of a capability that has failures, and the function that makes its failure from JSON. */
    private fun resultClass(base: String, valueType: KotlinType?, failures: Map<String, JsonElement>): Pair<String, String> {
        val failureName = unique("${base}Failure")
        val tagMembers = failures.entries.sortedBy { it.key }.map { (tag, schema) ->
            val data = failureData(schema)
            val type = if (data == null) null else typeOf(data, "$base${pascalCase(tag)}")
            Triple(tag, propertyName(camelCase(tag)), type)
        }
        val properties = listOf("tag") + tagMembers.filter { it.third != null }.map { it.second }
        check(properties.toSet().size == properties.size) {
            "$base: two tags of the failures give the same property name, or a tag gives the name tag. Give the tags other names."
        }
        val failureMembers = listOf(
            Member("tag", "tag", KotlinType.Plain("String", enumConstraint(tagMembers.map { it.first })), true, "The tag of the failure: ${tagMembers.joinToString(", ") { it.first }}."),
        ) + tagMembers.mapNotNull { (tag, property, type) ->
            type?.let { Member(tag, property, it, false, "The data of the failure $tag, when the tag is $tag.") }
        }
        classes[failureName] = GeneratedClass(failureName, "A failure: the reason why the capability did not do the operation.", failureMembers, null)

        val resultName = unique("${base}Result")
        val resultMembers = buildList {
            add(Member("ok", "ok", KotlinType.Plain("Boolean"), true, "True when the capability did the operation. False when it returned a failure in error."))
            if (valueType != null) add(Member("value", "value", valueType, false, "The value, when ok is true."))
            add(Member("error", "error", KotlinType.Generated(failureName), false, "The failure, when ok is false."))
        }
        classes[resultName] = GeneratedClass(resultName, "The result of the capability: a value or a failure.", resultMembers, null)

        val maker = "${failureName}Of"
        failureMakers[maker] = buildString {
            append("/** The failure of the JSON of a failure, with its `_tag`. */\n")
            append("internal fun $maker(error: JsonObject): $failureName {\n")
            append("    val tag = (error[\"_tag\"] as? JsonPrimitive)?.content.orEmpty()\n")
            append("    return when (tag) {\n")
            tagMembers.forEach { (tag, property, type) ->
                if (type == null) {
                    append("        ${literal(tag)} -> $failureName(tag = tag)\n")
                } else {
                    append("        ${literal(tag)} -> $failureName(tag = tag, ${identifier(property)} = ${fromJson(type, "error")})\n")
                }
            }
            append("        else -> $failureName(tag = tag)\n")
            append("    }\n")
            append("}\n")
        }
        return resultName to maker
    }

    private val failureMakers = LinkedHashMap<String, String>()

    /** The schema of the data of a failure: its object schema without `_tag`, or `null` when it has no other member. */
    private fun failureData(schema: JsonElement): JsonElement? {
        val obj = resolve(schema, types) as? JsonObject ?: return null
        val properties = obj.obj("properties").orEmpty().filterKeys { it != "_tag" }
        if (properties.isEmpty()) return null
        val required = obj.strings("required").filter { it != "_tag" }
        return JsonObject(
            obj.filterKeys { it != "properties" && it != "required" } +
                mapOf("properties" to JsonObject(properties), "required" to JsonArray(required.map(::JsonPrimitive))),
        )
    }

    // -----------------------------------------------------------------------------------------------------------
    // Types
    // -----------------------------------------------------------------------------------------------------------

    /** The members of an object schema. */
    private fun members(schema: JsonElement?, owner: String): List<Member> {
        val obj = schema?.let { resolve(it, types) } as? JsonObject ?: return emptyList()
        val required = obj.strings("required").toSet()
        val used = mutableSetOf<String>()
        return obj.obj("properties").orEmpty().map { (name, property) ->
            val kotlin = propertyName(name)
            check(used.add(kotlin)) { "$owner: two properties give the Kotlin name $kotlin." }
            val isRequired = name in required
            // A property that must be present but can be null has no Kotlin form: its JSON text keeps it.
            val type = if (isRequired && acceptsNull(property)) KotlinType.Json else typeOf(property, owner + pascalCase(name))
            Member(name, kotlin, type, isRequired, (resolve(property, types) as? JsonObject)?.string("description"))
        }
    }

    /** The Kotlin type of a schema. `name` is the name of a class that the schema can need. */
    private fun typeOf(schema: JsonElement, name: String): KotlinType {
        val reference = (schema as? JsonObject)?.string("\$ref")?.let(::referencedType)
        val obj = resolve(schema, types) as? JsonObject ?: return KotlinType.Json
        val target = withoutNull(obj) ?: return KotlinType.Json
        if (target.keys.any { it in COMPOSITION }) return KotlinType.Json
        val enum = target["enum"] as? JsonArray
        val const = target["const"]
        if (enum != null || const != null) {
            val values = (enum ?: JsonArray(listOf(const ?: JsonNull))).map { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content }
            if (values.any { it == null }) return KotlinType.Json
            return KotlinType.Plain("String", enumConstraint(values.filterNotNull()))
        }
        return when (singleType(target)) {
            "string" -> KotlinType.Plain("String", target.string("format")?.let { "@AppFunctionStringValueConstraint(format = ${literal(it)})" })
            "integer" -> KotlinType.Plain("Long")
            "number" -> KotlinType.Plain("Double")
            "boolean" -> KotlinType.Plain("Boolean")
            "array" -> arrayType(target, name)
            "object" -> objectType(target, reference ?: target.string("title")?.let(::pascalCase) ?: name, schema)
            else -> KotlinType.Json
        }
    }

    private fun arrayType(schema: JsonObject, name: String): KotlinType {
        if ("prefixItems" in schema) return KotlinType.Json
        val items = schema["items"] ?: return KotlinType.Json
        val itemObject = resolve(items, types) as? JsonObject ?: return KotlinType.Json
        // Items that are an enum of strings, with or without "type": "string", are strings.
        val enum = itemObject["enum"] as? JsonArray
        if (enum != null && enum.isNotEmpty() && enum.all { (it as? JsonPrimitive)?.isString == true } && itemObject.keys.none { it in COMPOSITION }) {
            return KotlinType.Plain("List<String>")
        }
        if (acceptsNull(itemObject) || itemObject.keys.any { it in COMPOSITION || it == "enum" || it == "const" }) return KotlinType.Json
        return when (singleType(itemObject)) {
            "string" -> KotlinType.Plain("List<String>")
            "integer" -> KotlinType.Plain("LongArray")
            "number" -> KotlinType.Plain("DoubleArray")
            "boolean" -> KotlinType.Plain("BooleanArray")
            "object" -> when (val item = typeOf(items, "${name}Item")) {
                is KotlinType.Generated -> KotlinType.ListOf(item.name)
                else -> KotlinType.Json
            }
            else -> KotlinType.Json
        }
    }

    /** A generated class for an object schema with properties. A free-form object keeps its JSON text. */
    private fun objectType(schema: JsonObject, wanted: String, original: JsonElement): KotlinType {
        val properties = schema.obj("properties") ?: return KotlinType.Json
        if (properties.isEmpty()) return KotlinType.Json
        if (schema["additionalProperties"].let { it != null && it != JsonPrimitive(false) }) return KotlinType.Json
        val key = bundle(original, types)
        // A class with the same wanted name and the same schema is one class. A different schema gets a new name.
        val existing = classes.values.firstOrNull { it.schema == key && wantedNames[it.name] == wanted }
        if (existing != null) return KotlinType.Generated(existing.name)
        val name = unique(wanted)
        wantedNames[name] = wanted
        // The first entry keeps the order of the classes, and lets a type that contains itself refer to its own class.
        classes[name] = GeneratedClass(name, null, emptyList(), key)
        classes[name] = GeneratedClass(name, schema.string("description"), members(schema, name), key)
        return KotlinType.Generated(name)
    }

    private fun unique(wanted: String): String {
        if (wanted !in classes && wanted != settings.baseName && wanted != settings.functionsName) return wanted
        var index = 2
        while ("$wanted$index" in classes) index += 1
        return "$wanted$index"
    }

    private fun withoutNull(schema: JsonObject): JsonObject? {
        val type = schema["type"]
        if (type is JsonArray) {
            val types = type.mapNotNull { (it as? JsonPrimitive)?.content }.filter { it != "null" }
            if (types.size != 1) return null
            return JsonObject(schema + ("type" to JsonPrimitive(types.single())))
        }
        val any = schema["anyOf"] as? JsonArray
        if (any != null && schema.keys.all { it == "anyOf" || it in ANNOTATIONS }) {
            val members = any.filter { member -> !(member is JsonObject && singleType(member) == "null" && member.size == 1) }
            if (members.size == 1 && members.size < any.size) return resolve(members.single(), types) as? JsonObject
        }
        return schema
    }

    private fun acceptsNull(schema: JsonElement): Boolean {
        val obj = resolve(schema, types) as? JsonObject ?: return schema == JsonPrimitive(true)
        val type = obj["type"]
        if (type is JsonArray) return type.any { (it as? JsonPrimitive)?.content == "null" }
        if (type is JsonPrimitive) return type.content == "null"
        val any = obj["anyOf"] as? JsonArray ?: obj["oneOf"] as? JsonArray
        if (any != null) return any.any { acceptsNull(it) }
        return "enum" !in obj && "const" !in obj && "\$ref" !in obj
    }

    private fun singleType(schema: JsonObject): String? = (schema["type"] as? JsonPrimitive)?.content

    /** A schema as an object, resolved when it is only a reference. */
    private fun resolvedObject(schema: JsonElement): JsonObject? = resolve(schema, types) as? JsonObject

    private fun enumConstraint(values: List<String>): String =
        "@AppFunctionStringValueConstraint(enumValues = [${values.joinToString(", ") { literal(it) }}])"

    private fun constraintOf(type: KotlinType): String? = (type as? KotlinType.Plain)?.constraint?.takeIf { type.text == "String" }

    // -----------------------------------------------------------------------------------------------------------
    // JSON
    // -----------------------------------------------------------------------------------------------------------

    /** The statement of the input builder that puts a parameter. */
    private fun toJson(member: Member): String {
        val name = literal(member.json)
        val value = identifier(member.kotlin)
        return when (val type = member.type) {
            is KotlinType.Json -> "putJson($name, $value)"
            is KotlinType.Generated -> "put($name, $value, ${type.name}.serializer())"
            is KotlinType.ListOf -> "putList($name, $value, ${type.name}.serializer())"
            is KotlinType.Plain -> "put($name, $value)"
        }
    }

    /** The expression that makes a value of a type from a JSON element. */
    private fun fromJson(type: KotlinType, json: String): String = when (type) {
        is KotlinType.Json -> "jsonTextOf($json)"
        is KotlinType.Generated -> "decode(${type.name}.serializer(), $json)"
        is KotlinType.ListOf -> "decode(ListSerializer(${type.name}.serializer()), $json)"
        is KotlinType.Plain -> "decode(serializer<${type.text}>(), $json)"
    }

    // -----------------------------------------------------------------------------------------------------------
    // Files
    // -----------------------------------------------------------------------------------------------------------

    private fun header() = "// Generated by the Gradle plugin dev.acidcat.appfunctions from the view of the target ${settings.target}. Do not edit.\n"

    private fun service(functions: List<Function>): String = buildString {
        append(header())
        append("package ${settings.packageName}\n\n")
        append("import androidx.appfunctions.AppFunctionDeclaration\n")
        append("import androidx.appfunctions.AppFunctionService\n")
        append("import androidx.appfunctions.AppFunctionServiceEntryPoint\n")
        append("import androidx.appfunctions.AppFunctionStringValueConstraint\n")
        append("import dev.acidcat.appfunctions.AppFunctionsBinding\n")
        append("import dev.acidcat.appfunctions.decode\n")
        append("import dev.acidcat.appfunctions.input\n")
        append("import dev.acidcat.appfunctions.jsonTextOf\n")
        append("import kotlinx.serialization.builtins.ListSerializer\n")
        append("import kotlinx.serialization.json.JsonNull\n")
        append("import kotlinx.serialization.serializer\n\n")
        view.string("title")?.let { append("/** The app functions of $it, for the target ${settings.target}. */\n") }
            ?: append("/** The app functions of the target ${settings.target}. */\n")
        append("@AppFunctionServiceEntryPoint(serviceName = ${literal(settings.serviceName)}, appFunctionXmlFileName = ${literal(settings.xmlFileName)})\n")
        append("public abstract class ${settings.baseName} : AppFunctionService() {\n")
        append("    private val binding: AppFunctionsBinding<*> by lazy { ${settings.provider}.binding(applicationContext) }\n")
        functions.forEach {
            append('\n')
            append(it.source)
        }
        append("}\n")
    }

    private fun functionsObject(functions: List<Function>): String = buildString {
        append(header())
        append("package ${settings.packageName}\n\n")
        append("import android.content.Context\n")
        append("import kotlinx.coroutines.CoroutineScope\n")
        append("import kotlinx.coroutines.Job\n\n")
        append("/** The app functions of the target ${settings.target}, by the id of their capability. */\n")
        append("public object ${settings.functionsName} {\n")
        append("    /** The function identifier of each capability. */\n")
        append("    public val ids: Map<String, String> = mapOf(\n")
        functions.forEach { append("        ${literal(it.id)} to ${literal("${settings.packageName}.${settings.baseName}#${it.name}")},\n") }
        append("    )\n\n")
        append("    /**\n")
        append("     * Keep the enabled state of each app function equal to the availability of its capability while `scope` is\n")
        append("     * active. Call it in `Application.onCreate`.\n")
        append("     */\n")
        append("    public fun keepAvailability(context: Context, scope: CoroutineScope): Job =\n")
        append("        ${settings.provider}.binding(context.applicationContext).keepAvailability(context.applicationContext, ids, scope)\n")
        append("}\n")
    }

    private fun typesFile(): String = buildString {
        append(header())
        append("package ${settings.packageName}\n\n")
        append("import androidx.appfunctions.AppFunctionSerializable\n")
        append("import androidx.appfunctions.AppFunctionStringValueConstraint\n")
        append("import dev.acidcat.appfunctions.JsonText\n")
        append("import dev.acidcat.appfunctions.decode\n")
        append("import kotlinx.serialization.SerialName\n")
        append("import kotlinx.serialization.Serializable\n")
        append("import kotlinx.serialization.json.JsonObject\n")
        append("import kotlinx.serialization.json.JsonPrimitive\n")
        classes.values.forEach { generated ->
            append('\n')
            append(kdoc(generated.description ?: "The type ${generated.name}.", emptyList(), indent = ""))
            val serializable = generated.schema != null
            append("@AppFunctionSerializable(isDescribedByKDoc = true)\n")
            if (serializable) append("@Serializable\n")
            append("public class ${generated.name}(\n")
            generated.members.forEach { member ->
                member.description?.let { append(kdoc(it, emptyList(), indent = "    ")) }
                append("    ")
                if (serializable && member.json != member.kotlin) append("@SerialName(${literal(member.json)}) ")
                if (serializable && member.type is KotlinType.Json) append("@Serializable(with = JsonText::class) ")
                constraintOf(member.type)?.let { append("@property:").append(it.removePrefix("@")).append(' ') }
                append("public val ${identifier(member.kotlin)}: ${member.type.text}")
                if (!member.required) append("? = null")
                append(",\n")
            }
            append(")\n")
        }
        failureMakers.values.forEach {
            append('\n')
            append(it)
        }
    }

    private fun appMetadata(instructions: String): String = buildString {
        append("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n")
        append("<!-- Generated by the Gradle plugin dev.acidcat.appfunctions. The instructions are the description of the catalog. -->\n")
        append("<AppFunctionAppMetadata xmlns:appfn=\"http://schemas.android.com/apk/res-auto\"\n")
        append("    appfn:instructions=\"${xmlAttribute(instructions)}\" />\n")
    }

    private fun manifest(): String = buildString {
        append("<?xml version=\"1.0\" encoding=\"utf-8\"?>\n")
        append("<!-- Generated by the Gradle plugin dev.acidcat.appfunctions. -->\n")
        append("<manifest xmlns:android=\"http://schemas.android.com/apk/res/android\">\n")
        append("    <application>\n")
        if (view.string("description") != null) {
            append("        <property\n")
            append("            android:name=\"android.app.appfunctions.app_metadata\"\n")
            append("            android:resource=\"@xml/acidcat_app_metadata\" />\n")
        }
        append("        <service\n")
        append("            android:name=\"${settings.packageName}.${settings.serviceName}\"\n")
        append("            android:exported=\"true\"\n")
        append("            android:permission=\"android.permission.BIND_APP_FUNCTION_SERVICE\">\n")
        append("            <property\n")
        append("                android:name=\"android.app.appfunctions.schema\"\n")
        append("                android:value=\"app_functions_schema.xsd\" />\n")
        append("            <property\n")
        append("                android:name=\"android.app.appfunctions.v2\"\n")
        append("                android:value=\"${settings.xmlFileName}.xml\" />\n")
        append("            <intent-filter>\n")
        append("                <action android:name=\"android.app.appfunctions.AppFunctionService\" />\n")
        append("            </intent-filter>\n")
        append("        </service>\n")
        append("    </application>\n")
        append("</manifest>\n")
    }

    private companion object {
        val COMPOSITION = setOf("oneOf", "anyOf", "allOf", "not", "if", "patternProperties", "prefixItems")
        val ANNOTATIONS = setOf("title", "description", "default", "examples", "deprecated", "readOnly", "writeOnly", "\$comment")
    }
}

// ---------------------------------------------------------------------------------------------------------------
// Names and text
// ---------------------------------------------------------------------------------------------------------------

private val KEYWORDS = setOf(
    "as", "break", "class", "continue", "do", "else", "false", "for", "fun", "if", "in", "interface", "is", "null", "object",
    "package", "return", "super", "this", "throw", "true", "try", "typealias", "typeof", "val", "var", "when", "while",
)

private val IDENTIFIER = Regex("^[A-Za-z_][A-Za-z0-9_]*$")

/**
 * The Kotlin name of a JSON property: the name itself when it is an identifier. Each other character gives `_`, and a
 * name that starts with a digit gets `_` before it. A keyword gets `_` after it, because the code that the AppFunctions
 * compiler writes does not put keywords in backticks.
 */
internal fun propertyName(json: String): String {
    if (IDENTIFIER.matches(json)) return if (json in KEYWORDS) "${json}_" else json
    val replaced = json.map { if (it.isLetterOrDigit() && it.code < 128 || it == '_') it else '_' }.joinToString("")
    return if (replaced.firstOrNull()?.isDigit() != false) "_$replaced" else replaced
}

/** A name in code. The names of [propertyName] are never keywords. */
private fun identifier(name: String): String = name

/** A name in PascalCase: each run of letters and digits starts with a capital letter. */
internal fun pascalCase(text: String): String {
    val words = Regex("[A-Za-z0-9]+").findAll(text).map { it.value }.toList()
    val name = words.joinToString("") { word -> word.replaceFirstChar { it.uppercaseChar() } }
    return if (name.isEmpty() || name.first().isDigit()) "T$name" else name
}

/** A name in camelCase. */
internal fun camelCase(text: String): String = pascalCase(text).replaceFirstChar { it.lowercaseChar() }

/** A name in snake_case, for a resource or an asset. */
internal fun snakeCase(text: String): String =
    text.replace(Regex("([a-z0-9])([A-Z])"), "$1_$2").replace(Regex("[^A-Za-z0-9]+"), "_").lowercase()

/** A Kotlin string literal. */
private fun literal(text: String): String = buildString {
    append('"')
    text.forEach { char ->
        when (char) {
            '"' -> append("\\\"")
            '\\' -> append("\\\\")
            '$' -> append("\\$")
            '\n' -> append("\\n")
            '\r' -> append("\\r")
            '\t' -> append("\\t")
            else -> if (char < ' ') append("\\u").append(char.code.toString(16).padStart(4, '0')) else append(char)
        }
    }
    append('"')
}

/** A KDoc comment with a description and the descriptions of parameters. */
private fun kdoc(description: String, parameters: List<Pair<String, String?>>, indent: String): String = buildString {
    val lines = comment(description).lines()
    val documented = parameters.filter { it.second != null }
    append(indent).append("/**\n")
    lines.forEach { append(indent).append(" *").append(if (it.isEmpty()) "" else " $it").append('\n') }
    if (documented.isNotEmpty()) {
        append(indent).append(" *\n")
        documented.forEach { (name, text) -> append(indent).append(" * @param $name ${comment(text.orEmpty()).replace("\n", " ")}\n") }
    }
    append(indent).append(" */\n")
}

/** Text that is safe in a KDoc comment. */
private fun comment(text: String): String = text.trim().replace("*/", "*&#47;").replace("/*", "&#47;*")

/** Text that is safe in an XML attribute. */
private fun xmlAttribute(text: String): String =
    text.replace("&", "&amp;").replace("\"", "&quot;").replace("<", "&lt;").replace(">", "&gt;").replace("\n", "&#10;")
