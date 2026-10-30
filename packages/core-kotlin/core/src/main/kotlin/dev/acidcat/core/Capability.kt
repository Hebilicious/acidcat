/*
 * Capabilities and applications. An application writes its own catalog (spec/catalog.md).
 */
package dev.acidcat.core

import kotlinx.coroutines.flow.StateFlow
import kotlinx.serialization.ExperimentalSerializationApi
import kotlinx.serialization.KSerializer
import kotlinx.serialization.descriptors.PolymorphicKind
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.serializer

/** What `run` receives beside the input: the context of the session, and the id of the capability. */
public class Call<out Context> internal constructor(
    public val context: Context,
    public val id: String,
)

/**
 * The failures of a capability: the serializer of a sealed class, and the schema of each tag. Each subclass is one tag.
 * Its `@SerialName` is the tag, and the JSON form of a failure has the tag in `_tag` (spec/catalog.md#failures).
 */
public class Failures<F> internal constructor(
    public val serializer: KSerializer<F>,
    /** The schema of each failure, with its `_tag`, by tag. */
    public val schemas: Map<String, JsonElement>,
    public val types: Map<String, JsonElement>,
) {
    private val validators: Map<String, Schema<JsonElement>> by lazy {
        schemas.mapValues { (_, schema) -> Schema.of(JsonElement.serializer(), schema, types) }
    }

    /** The JSON form of a failure, checked against the schema of its tag. A failure that does not agree throws. */
    internal fun encode(failure: F): JsonObject {
        val json = AcidCatJson.encodeToJsonElement(serializer, failure) as? JsonObject
            ?: throw IllegalStateException("A failure is not a JSON object.")
        val tag = json.string("_tag") ?: throw IllegalStateException("A failure has no _tag.")
        val schema = validators[tag] ?: throw IllegalStateException("The failure $tag is not in failures.")
        val problems = schema.problems(json)
        check(problems.isEmpty()) { "The failure $tag does not agree with its schema: ${problems.first()}" }
        return json
    }

    public companion object {
        /** The failures of a sealed class. Each subclass is one tag, and its schema comes from its serializer. */
        @OptIn(ExperimentalSerializationApi::class)
        public fun <F> of(serializer: KSerializer<F>): Failures<F> {
            val descriptor = serializer.descriptor
            require(descriptor.kind == PolymorphicKind.SEALED) {
                "${descriptor.serialName}: failures are a sealed class. Each subclass is one tag."
            }
            val types = LinkedHashMap<String, JsonElement>()
            val writer = SchemaWriter(types)
            val subclasses = descriptor.getElementDescriptor(1)
            val schemas = LinkedHashMap<String, JsonElement>()
            for (index in 0 until subclasses.elementsCount) {
                val subclass = subclasses.getElementDescriptor(index)
                val tag = subclass.serialName
                require(tag.isNotEmpty() && '.' !in tag) {
                    "${descriptor.serialName}: give each subclass its tag with @SerialName, for example @SerialName(\"Offline\")."
                }
                schemas[tag] = tagged(writer.schemaOf(subclass, emptyList()), tag, types)
            }
            return Failures(serializer, schemas, types)
        }

        /** The failures of a sealed class, with a schema for each tag that the application writes. */
        public fun <F> of(serializer: KSerializer<F>, schemas: Map<String, JsonElement>, types: Map<String, JsonElement> = emptyMap()): Failures<F> =
            Failures(serializer, schemas, types)

        /** A failure schema with `_tag` as a required constant. */
        private fun tagged(schema: JsonElement, tag: String, types: Map<String, JsonElement>): JsonElement {
            val obj = resolve(schema, types) as? JsonObject ?: return schema
            val properties = LinkedHashMap<String, JsonElement>()
            properties["_tag"] = JsonObject(linkedMapOf("type" to JsonPrimitive("string"), "const" to JsonPrimitive(tag)))
            properties.putAll(obj.obj("properties").orEmpty())
            val required = listOf("_tag") + obj.strings("required").filter { it != "_tag" }
            return JsonObject(obj + mapOf("properties" to JsonObject(properties), "required" to JsonArray(required.map(::JsonPrimitive))))
        }
    }
}

/** The failures of a sealed class. */
public inline fun <reified F> failuresOf(): Failures<F> = Failures.of(serializer<F>())

/** The state of a capability (spec/invocation.md#state): its schema, and its source for a context. */
public class CapabilityState<in Context, S> internal constructor(
    public val schema: Schema<S>,
    internal val source: (Context) -> StateFlow<S>,
)

/**
 * A capability: one operation that a client can do (spec/catalog.md#capabilities). `Context` is the type of the
 * services that `run` receives. `Input`, `Value`, `Failure` and `State` are the types of its schemas.
 */
public class Capability<in Context, Input, Value, Failure, State> internal constructor(
    public val id: String,
    public val description: String,
    public val audience: List<String>,
    public val readOnly: Boolean,
    /** The input schema. It is [NoInput] when the capability has no input. Then the input is [Unit]. */
    public val input: Schema<Input>,
    /** The output schema. It is [NoOutput] when the capability has no output. Then the value is [Unit], and its JSON is `null`. */
    public val output: Schema<Value>,
    public val failures: Failures<Failure>?,
    public val state: CapabilityState<Context, State>?,
    internal val availability: ((Context) -> StateFlow<Availability>)?,
    internal val run: suspend Call<Context>.(Input) -> Result<Value, Failure>,
)

/**
 * Declares a capability, one member at a time. Each member that has a type gives a new builder with that type. `run`
 * ends the declaration.
 */
public class CapabilityBuilder<Context, Input, Value, Failure, State> internal constructor(
    private val id: String,
    private val description: String,
    private val audience: List<String>,
    private val readOnly: Boolean,
    private val input: Schema<Input>,
    private val output: Schema<Value>,
    private val failures: Failures<Failure>?,
    private val state: CapabilityState<Context, State>?,
    private val availability: ((Context) -> StateFlow<Availability>)?,
) {
    /** The input schema. `run` receives the decoded input. */
    public fun <T> input(schema: Schema<T>): CapabilityBuilder<Context, T, Value, Failure, State> =
        CapabilityBuilder(id, description, audience, readOnly, schema, output, failures, state, availability)

    /** The input schema of a Kotlin type, made from its serializer. */
    public inline fun <reified T> input(): CapabilityBuilder<Context, T, Value, Failure, State> = input(schemaOf<T>())

    /** The output schema: the schema of the value of a successful call. */
    public fun <T> output(schema: Schema<T>): CapabilityBuilder<Context, Input, T, Failure, State> =
        CapabilityBuilder(id, description, audience, readOnly, input, schema, failures, state, availability)

    /** The output schema of a Kotlin type, made from its serializer. */
    public inline fun <reified T> output(): CapabilityBuilder<Context, Input, T, Failure, State> = output(schemaOf<T>())

    /** The failures that the capability can return. */
    public fun <T> failures(failures: Failures<T>): CapabilityBuilder<Context, Input, Value, T, State> =
        CapabilityBuilder(id, description, audience, readOnly, input, output, failures, state, availability)

    /** The failures of a sealed class: each subclass is one tag. */
    public inline fun <reified T> failures(): CapabilityBuilder<Context, Input, Value, T, State> = failures(failuresOf<T>())

    /** A value that clients can observe (spec/invocation.md#state): its schema, and its source for a context. */
    public fun <T> state(schema: Schema<T>, source: (Context) -> StateFlow<T>): CapabilityBuilder<Context, Input, Value, Failure, T> =
        CapabilityBuilder(id, description, audience, readOnly, input, output, failures, CapabilityState(schema, source), availability)

    /** A value that clients can observe, with the schema of a Kotlin type. */
    public inline fun <reified T> state(noinline source: (Context) -> StateFlow<T>): CapabilityBuilder<Context, Input, Value, Failure, T> =
        state(schemaOf<T>(), source)

    /** The availability of the capability for a context. With none, the capability is always available. */
    public fun availability(source: (Context) -> StateFlow<Availability>): CapabilityBuilder<Context, Input, Value, Failure, State> =
        CapabilityBuilder(id, description, audience, readOnly, input, output, failures, state, source)

    /** Mark the capability `readOnly`: a call changes nothing that a client can see. */
    public fun readOnly(): CapabilityBuilder<Context, Input, Value, Failure, State> =
        CapabilityBuilder(id, description, audience, true, input, output, failures, state, availability)

    /**
     * The operation. It receives the input, with the [Call] as its receiver, and returns [ok] or [fail]. If it throws,
     * the call fails as `internal`. A cancelled call cancels its coroutine.
     */
    public fun run(block: suspend Call<Context>.(Input) -> Result<Value, Failure>): Capability<Context, Input, Value, Failure, State> =
        Capability(id, description, audience, readOnly, input, output, failures, state, availability, block)
}

/** The function that [capabilitiesFor] gives: start a capability with one context type. */
public class CapabilityFactory<Context> internal constructor() {
    /**
     * Start a capability with its id, its description and its audience. With no other member, it has no input, no output
     * and no failures.
     */
    public operator fun invoke(id: String, description: String, audience: List<String>): CapabilityBuilder<Context, Unit, Unit, Nothing, Nothing> {
        require(isId(id)) { "$id is not an id (spec/catalog.md#ids)." }
        require(description.isNotBlank()) { "$id: give the capability a description." }
        return CapabilityBuilder(id, description, audience, false, NoInput, NoOutput, null, null, null)
    }
}

/**
 * Declare capabilities for one context type:
 *
 * ```kotlin
 * val capability = capabilitiesFor<Unit>()
 * val powerSet = capability("aircon.power.set", "Turn the unit on or off.", listOf("cli", "mcp"))
 *     .input<PowerInput>()
 *     .run { input -> context.unit.setPower(input.on); ok() }
 * ```
 */
public fun <Context> capabilitiesFor(): CapabilityFactory<Context> = CapabilityFactory()

/** A target: a group of clients that can use a set of capabilities (spec/catalog.md#targets). */
public class Target(
    public val bindings: List<String>,
    public val description: String? = null,
    public val options: JsonObject? = null,
)

/** An application: its targets and its capabilities. */
public class App<Context>(
    public val title: String? = null,
    public val description: String? = null,
    public val targets: Map<String, Target>,
    public val capabilities: List<Capability<Context, *, *, *, *>>,
) {
    /** The catalog of the application, as a JSON document. It is written one time, when it is first read. */
    public val catalog: JsonObject by lazy { CatalogWriter(this).write() }

    /** The catalog, as text in canonical form. */
    public fun renderCatalog(): String = canonicalText(catalog)
}

/** Writes the catalog of an application, and checks the rules that the code cannot check by its types. */
private class CatalogWriter(private val app: App<*>) {
    private val types = LinkedHashMap<String, JsonElement>()

    private fun share(where: String, more: Map<String, JsonElement>) {
        for ((name, type) in more) {
            val existing = types[name]
            require(existing == null || existing == type) { "$where: two different schemas have the name $name. Give each one its own name." }
            types[name] = type
        }
    }

    fun write(): JsonObject {
        app.targets.keys.forEach { require(isTargetName(it)) { "$it is not a target name (spec/catalog.md#targets)." } }
        val capabilities = LinkedHashMap<String, JsonElement>()
        for (capability in app.capabilities) {
            val id = capability.id
            require(id !in capabilities) { "The capability $id is declared two times." }
            capability.audience.forEach { require(it in app.targets) { "$id: the audience $it is not a target." } }
            val members = LinkedHashMap<String, JsonElement>()
            members["description"] = JsonPrimitive(capability.description)
            members["audience"] = JsonArray(capability.audience.map(::JsonPrimitive))
            capability.input.takeIf { it !== NoInput }?.let { schema ->
                share(id, schema.types)
                val input = (schema.json as? JsonObject)?.let { objectInput(it, types) }
                require(input != null && isObjectSchema(input)) { "$id: the input schema must be an object (spec/catalog.md#capabilities)." }
                members["input"] = input
            }
            capability.output.takeIf { it !== NoOutput }?.let { schema ->
                share(id, schema.types)
                members["output"] = schema.json
            }
            capability.failures?.let { failures ->
                share(id, failures.types)
                members["failures"] = JsonObject(failures.schemas)
            }
            if (capability.readOnly) members["readOnly"] = JsonPrimitive(true)
            capability.state?.let { state ->
                share(id, state.schema.types)
                members["state"] = state.schema.json
            }
            capabilities[id] = JsonObject(members)
        }
        return JsonObject(
            buildMap {
                put("acidcat", JsonPrimitive(ACIDCAT_VERSION))
                app.title?.let { put("title", JsonPrimitive(it)) }
                app.description?.let { put("description", JsonPrimitive(it)) }
                put("targets", JsonObject(app.targets.mapValues { (_, target) -> target.toJson() }))
                if (types.isNotEmpty()) put("\$defs", JsonObject(types))
                put("capabilities", JsonObject(capabilities))
            },
        )
    }

    private fun isObjectSchema(schema: JsonObject): Boolean {
        if (schema.string("type") == "object") return true
        val name = schema.string("\$ref")?.let(::referencedType) ?: return false
        return (types[name] as? JsonObject)?.string("type") == "object"
    }

    private fun Target.toJson(): JsonObject = JsonObject(
        buildMap {
            put("bindings", JsonArray(bindings.map(::JsonPrimitive)))
            description?.let { put("description", JsonPrimitive(it)) }
            options?.let { put("options", it) }
        },
    )
}
