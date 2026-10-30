/*
 * The CLI binding (spec/bindings/cli.md): a command line made from the catalog.
 */
package dev.acidcat.core

import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.async
import kotlinx.coroutines.runBlocking
import kotlinx.coroutines.withTimeoutOrNull
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlin.system.exitProcess

/** The exit code of each outcome (spec/bindings/cli.md#outcomes). */
public object CliExitCodes {
    public const val VALUE: Int = 0
    public const val FAILURE: Int = 1
    public const val UNKNOWN_CAPABILITY: Int = 2
    public const val INVALID_INPUT: Int = 3
    public const val UNAVAILABLE: Int = 4
    public const val INTERNAL: Int = 5
    public const val CANCELLED: Int = 130

    /** The exit code of an outcome. */
    public fun of(outcome: Outcome): Int = when (outcome) {
        is Outcome.Completed -> if (outcome.result is Result.Ok) VALUE else FAILURE
        is Outcome.Failed -> when (outcome.failure.kind) {
            CallFailureKind.UnknownCapability -> UNKNOWN_CAPABILITY
            CallFailureKind.InvalidInput -> INVALID_INPUT
            CallFailureKind.Unavailable -> UNAVAILABLE
            CallFailureKind.Internal -> INTERNAL
            CallFailureKind.Cancelled -> CANCELLED
        }
    }
}

/** The output of the command line. */
public class CliIo(
    public val stdout: (String) -> Unit,
    public val stderr: (String) -> Unit,
)

/** A command that the application adds to the command line. */
public class CliCommand<in Context>(
    public val name: String,
    /** The text that the help gives for the command. */
    public val description: String,
    /** Run the command with the arguments that come after its name. The result is the exit code. */
    public val run: suspend (args: List<String>, io: CliIo, context: Context) -> Int,
)

/** The settings of the CLI binding. */
public class CliSettings<Context>(
    public val name: String,
    public val version: String,
    public val context: Context,
    /** The target that the command line serves. */
    public val target: String = "cli",
    /** The text at the top of the help. The default is the description of the application, then its title, then [name]. */
    public val description: String? = null,
    /**
     * The commands of the application, beside the commands of the capabilities, `call` and `list`. The name of each one
     * must not be `call`, `list`, the name of another command of the application, or the first word of the command of a
     * capability (spec/bindings/cli.md#commands).
     */
    public val commands: List<CliCommand<Context>> = emptyList(),
    public val session: SessionOptions = SessionOptions(),
)

/** The flags of a command, as `usage` writes them: required flags first, each group in code point order of the names. */
public fun cliFlags(input: JsonObject): List<String> {
    val properties = input.obj("properties").orEmpty()
    val definitions = input.obj("\$defs").orEmpty()
    val required = input.strings("required").toSet()
    val names = properties.keys.sortedWith(CodePointOrder)
    return (names.filter { it in required } + names.filter { it !in required }).map { name ->
        val property = resolve(properties.getValue(name), definitions) as? JsonObject ?: JsonObject(emptyMap())
        val items = repeatedItems(property, definitions)
        val flag = when {
            items != null -> "--$name <${flagValue(items)}>..."
            property.string("type") == "boolean" -> "--$name"
            else -> "--$name <${flagValue(property)}>"
        }
        if (name in required) flag else "[$flag]"
    }
}

/**
 * The schema of the items of a repeated flag, or `null` when the property does not give a repeated flag. A property
 * gives a repeated flag when its type is `array`, and its `items` schema, or the type that it refers to, is an `enum`
 * of strings, `integer`, `number` or `string`. `property` is already resolved.
 */
private fun repeatedItems(property: JsonObject, definitions: Map<String, JsonElement>): JsonObject? {
    if (property.string("type") != "array") return null
    val items = property["items"]?.let { resolve(it, definitions) } as? JsonObject ?: return null
    return items.takeIf { stringEnum(it) != null || it.string("type") in setOf("integer", "number", "string") }
}

/** The strings of an `enum` that has only strings, or `null`. */
private fun stringEnum(schema: JsonObject): List<String>? {
    val enum = schema["enum"] as? JsonArray ?: return null
    val strings = enum.map { (it as? JsonPrimitive)?.takeIf { value -> value.isString }?.content ?: return null }
    return strings.ifEmpty { null }
}

private fun flagValue(property: JsonObject): String {
    stringEnum(property)?.let { return it.joinToString("|") }
    return when (val type = property.string("type")) {
        "integer", "number", "string" -> type
        else -> "json"
    }
}

/** The `usage` of a capability in `list`. `input` is the bundled input schema, or `null` when the capability has no input. */
public fun cliUsage(program: String, id: String, input: JsonObject?): String {
    if (input != null && "properties" !in input) return "$program call $id '<json>'"
    return (listOf(program) + id.split('.') + (input?.let(::cliFlags) ?: emptyList())).joinToString(" ")
}

private class UsageError(message: String, val exitCode: Int) : Exception(message)

/**
 * Run the command line as the main program of the process, and exit with its code. An interrupt (`SIGINT`) cancels the
 * call. The process then exits with the code 130.
 */
public fun <Context> cliMain(app: App<Context>, settings: CliSettings<Context>, args: Array<String>): Nothing {
    val io = CliIo(stdout = { println(it) }, stderr = { System.err.println(it) })
    val code = runBlocking {
        val run = async(start = CoroutineStart.LAZY) { runCli(app, settings, args.toList(), io) }
        // The JVM runs its shutdown hooks on SIGINT, then exits with 130. The hook cancels the call and waits for its session.
        val hook = Thread {
            run.cancel()
            runBlocking { withTimeoutOrNull(5_000) { run.join() } }
        }
        Runtime.getRuntime().addShutdownHook(hook)
        try {
            run.await()
        } finally {
            try {
                Runtime.getRuntime().removeShutdownHook(hook)
            } catch (_: IllegalStateException) {
                // The JVM is shutting down, so the hook runs.
            }
        }
    }
    System.out.flush()
    exitProcess(code)
}

/** Run the command line with arguments. The result is the exit code. The cancellation of the coroutine cancels the call. */
public suspend fun <Context> runCli(app: App<Context>, settings: CliSettings<Context>, args: List<String>, io: CliIo): Int {
    val session = app.openSession(settings.target, settings.context, settings.session)
    val view = session.view
    val types = view.obj("\$defs").orEmpty()
    val capabilities = view.obj("capabilities").orEmpty()
    val commands = capabilities.keys.map { id -> id to id.split('.') }
    for ((_, path) in commands) {
        check(path[0] != "call" && path[0] != "list") { "The command ${path.joinToString(" ")} has the same name as a command of the command line." }
    }
    val taken = mutableSetOf("call", "list").apply { addAll(commands.map { it.second[0] }) }
    for (command in settings.commands) {
        check(taken.add(command.name)) { "The command ${command.name} of the application has the same name as another command." }
    }

    fun print(outcome: Outcome): Int {
        when (outcome) {
            is Outcome.Failed -> io.stderr(jsonText(outcome.failure.toJson()))
            is Outcome.Completed -> io.stdout(
                pretty(
                    when (val result = outcome.result) {
                        is Result.Ok -> result.value
                        is Result.Failed -> result.error
                    },
                ),
            )
        }
        return CliExitCodes.of(outcome)
    }

    return session.use {
        try {
            val first = args.firstOrNull()
            val rest = args.drop(1)
            when {
                first == null || first == "--help" || first == "-h" -> {
                    val description = settings.description ?: app.description ?: app.title ?: settings.name
                    io.stdout(help(settings.name, description, commands.map { it.second.joinToString(" ") }, settings.commands))
                    CliExitCodes.VALUE
                }
                first == "--version" || first == "-v" -> {
                    io.stdout(settings.version)
                    CliExitCodes.VALUE
                }
                first == "list" -> {
                    val list = session.handles.values.map { handle ->
                        val input = capabilities.obj(handle.id)?.get("input")?.let { bundle(it, types) as? JsonObject }
                        JsonObject(
                            buildMap {
                                put("id", JsonPrimitive(handle.id))
                                put("description", JsonPrimitive(handle.description))
                                putAll(handle.availability.value.toJson())
                                put("usage", JsonPrimitive(cliUsage(settings.name, handle.id, input)))
                            },
                        )
                    }
                    io.stdout(pretty(JsonArray(list)))
                    CliExitCodes.VALUE
                }
                first == "call" -> {
                    val id = rest.firstOrNull() ?: throw UsageError("Give the id of a capability.", CliExitCodes.INVALID_INPUT)
                    val input = try {
                        AcidCatJson.parseToJsonElement(rest.getOrElse(1) { "{}" })
                    } catch (_: SerializationException) {
                        return@use print(Outcome.failed(CallFailureKind.InvalidInput, "The input is not JSON."))
                    }
                    print(session.invoke(id, input))
                }
                else -> {
                    settings.commands.firstOrNull { it.name == first }?.let { return@use it.run(rest, io, settings.context) }
                    val match = commands
                        .filter { (_, path) -> path.withIndex().all { (index, word) -> args.getOrNull(index) == word } }
                        .maxByOrNull { it.second.size }
                        ?: throw UsageError("There is no command ${args.filter { !it.startsWith("-") }.joinToString(" ")}.", CliExitCodes.UNKNOWN_CAPABILITY)
                    val (id, path) = match
                    val capability = capabilities.getValue(id) as JsonObject
                    val schema = bundle(capability["input"] ?: JsonObject(mapOf("type" to JsonPrimitive("object"))), types) as? JsonObject
                        ?: JsonObject(emptyMap())
                    val flagArgs = args.drop(path.size)
                    if ("--help" in flagArgs || "-h" in flagArgs) {
                        io.stdout(usage(settings.name, path, capability.string("description").orEmpty(), schema))
                        CliExitCodes.VALUE
                    } else {
                        print(session.invoke(id, parseFlags(flagArgs, schema)))
                    }
                }
            }
        } catch (error: UsageError) {
            io.stderr(error.message.orEmpty())
            error.exitCode
        }
    }
}

/** Make the input from the flags (spec/bindings/cli.md#commands). */
private fun parseFlags(args: List<String>, schema: JsonObject): JsonObject {
    val properties = schema.obj("properties").orEmpty()
    val definitions = schema.obj("\$defs").orEmpty()
    val input = LinkedHashMap<String, JsonElement>()
    // The values of each repeated flag, in the order of the flags, with the schema of its items.
    val repeated = LinkedHashMap<String, Pair<JsonObject, MutableList<String>>>()
    val remaining = args.iterator()
    while (remaining.hasNext()) {
        val arg = remaining.next()
        if (!arg.startsWith("--")) throw UsageError("Unexpected argument $arg.", CliExitCodes.INVALID_INPUT)
        val name = arg.drop(2).substringBefore('=')
        val inline = if ('=' in arg) arg.substringAfter('=') else null
        val property = properties[name] ?: throw UsageError("Unknown flag --$name.", CliExitCodes.INVALID_INPUT)
        val type = resolve(property, definitions) as? JsonObject ?: JsonObject(emptyMap())
        if (type.string("type") == "boolean") {
            input[name] = JsonPrimitive(inline == null || inline == "true")
            continue
        }
        val text = inline ?: (if (remaining.hasNext()) remaining.next() else null)
            ?: throw UsageError("The flag --$name needs a value.", CliExitCodes.INVALID_INPUT)
        val items = repeatedItems(type, definitions)
        if (items == null) input[name] = valueOf(name, text, type) else repeated.getOrPut(name) { items to mutableListOf() }.second += text
    }
    // A repeated flag gives JSON text of the whole array, when it occurs once with that text, or one item for each flag.
    for ((name, flag) in repeated) {
        val (items, values) = flag
        val whole = values.singleOrNull()?.let { text -> runCatching { AcidCatJson.parseToJsonElement(text) }.getOrNull() } as? JsonArray
        input[name] = whole ?: JsonArray(values.map { valueOf(name, it, items) })
    }
    for (name in schema.strings("required")) {
        if (name !in input) throw UsageError("The flag --$name is required.", CliExitCodes.INVALID_INPUT)
    }
    return JsonObject(input)
}

private fun valueOf(name: String, text: String, type: JsonObject): JsonElement {
    val values = stringEnum(type)
    if (values != null) {
        if (text !in values) throw UsageError("The flag --$name must be one of: ${values.joinToString(", ")}.", CliExitCodes.INVALID_INPUT)
        return JsonPrimitive(text)
    }
    when (val kind = type.string("type")) {
        "integer", "number" -> {
            val number = text.trim().takeIf { it.isNotEmpty() }?.toDoubleOrNull()
            if (number == null || !number.isFinite() || (kind == "integer" && number % 1.0 != 0.0)) {
                throw UsageError("The flag --$name must be a $kind.", CliExitCodes.INVALID_INPUT)
            }
            return if (number % 1.0 == 0.0 && kotlin.math.abs(number) < 9.007199254740992E15) JsonPrimitive(number.toLong()) else JsonPrimitive(number)
        }
        "string" -> return JsonPrimitive(text)
    }
    return try {
        AcidCatJson.parseToJsonElement(text)
    } catch (_: SerializationException) {
        throw UsageError("The flag --$name must be JSON.", CliExitCodes.INVALID_INPUT)
    }
}

/** JSON with two-space indentation, as `JSON.stringify(value, null, 2)` writes it. */
public fun pretty(value: JsonElement, indent: String = ""): String = when (value) {
    is JsonArray -> if (value.isEmpty()) "[]" else value.joinToString(",\n", "[\n", "\n$indent]") { "$indent  ${pretty(it, "$indent  ")}" }
    is JsonObject -> if (value.isEmpty()) "{}" else value.entries.joinToString(",\n", "{\n", "\n$indent}") { (key, item) ->
        "$indent  ${jsonString(key)}: ${pretty(item, "$indent  ")}"
    }
    else -> jsonText(value)
}

private fun help(name: String, description: String, paths: List<String>, added: List<CliCommand<*>>): String = buildList {
    add(description)
    add("")
    add("Usage: $name <command> [flags]")
    add("")
    add("Commands:")
    paths.forEach { add("  $it") }
    add("  call <id> [input]")
    add("  list")
    added.forEach { add("  ${it.name}  ${it.description}") }
}.joinToString("\n")

private fun usage(name: String, path: List<String>, description: String, schema: JsonObject): String =
    "Usage: ${(listOf(name) + path + cliFlags(schema)).joinToString(" ")}\n\n$description"
