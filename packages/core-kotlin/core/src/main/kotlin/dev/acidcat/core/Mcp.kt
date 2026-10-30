/*
 * The MCP binding (spec/bindings/mcp.md): an MCP server through HTTP, revision 2026-07-28, with no state on the server
 * between requests.
 */
package dev.acidcat.core

import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonArray
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject

/** The MCP revision that the binding serves. */
public const val MCP_PROTOCOL_VERSION: String = "2026-07-28"

/** The JSON-RPC error of a call to an unknown tool. */
public const val MCP_UNKNOWN_TOOL: Int = -32602

/** Where the context of each request comes from: one context for all requests, or a new context for each request. */
public sealed interface ContextSource<Context> {
    /** One context that all requests share. */
    public class Shared<Context>(public val context: Context) : ContextSource<Context>

    /** A new context for each request that passes the screening. `release` runs after the response. */
    public class PerRequest<Context>(
        public val create: suspend (WebRequest) -> Context,
        public val release: suspend (Context) -> Unit = {},
    ) : ContextSource<Context>
}

/** Give the context of one request to `use`, and release it afterwards if the source made it. */
internal suspend fun <Context, R> ContextSource<Context>.with(request: WebRequest, use: suspend (Context) -> R): R = when (this) {
    is ContextSource.Shared -> use(context)
    is ContextSource.PerRequest -> {
        val context = create(request)
        try {
            use(context)
        } finally {
            release(context)
        }
    }
}

/** The settings of the MCP binding. */
public class McpSettings(
    public val name: String,
    public val version: String,
    /** The origins that can call the server. A request with no `Origin` header is accepted. */
    public val allowedOrigins: List<String>,
    /**
     * Guidance for a model about the whole server, which `server/discover` gives as `instructions`. The default is the
     * description of the application.
     */
    public val instructions: String? = null,
    /** The target that the server serves. */
    public val target: String = "mcp",
    /** The maximum size of a request body, in bytes. */
    public val maximumBytes: Long = 1_048_576,
    public val session: SessionOptions = SessionOptions(),
)

/** A web handler for the MCP server. Each request has its own session. */
public fun <Context> mcpHandler(app: App<Context>, settings: McpSettings, context: Context): WebHandler =
    mcpHandler(app, settings, ContextSource.Shared(context))

/** A web handler for the MCP server. Each request has its own session, and with [ContextSource.PerRequest] its own context. */
public fun <Context> mcpHandler(app: App<Context>, settings: McpSettings, context: ContextSource<Context>): WebHandler = WebHandler { request ->
    screenRequest(request, listOf("POST"), settings.allowedOrigins, settings.maximumBytes)?.let { return@WebHandler mcpRejection(it) }
    val text = when (val body = readBounded(request.body, settings.maximumBytes)) {
        is BoundedText.Rejected -> return@WebHandler mcpRejection(body.rejection)
        is BoundedText.Text -> body.text
    }
    val message = try {
        JsonRpcRequest.of(AcidCatJson.parseToJsonElement(text))
    } catch (_: SerializationException) {
        return@WebHandler mcpRejection(Rejection.NotUtf8)
    }

    // Revision 2026-07-28: each request names its revision in a header, and each request repeats it in `_meta`.
    val version = request.header("MCP-Protocol-Version")
    val id = message.id ?: JsonNull
    if (version == null) return@WebHandler rpcError(400, id, -32020, "MCP-Protocol-Version header is required")
    if (version != MCP_PROTOCOL_VERSION) {
        val data = buildJsonObject { put("supported", buildJsonArray { add(JsonPrimitive(MCP_PROTOCOL_VERSION)) }) }
        return@WebHandler rpcError(400, id, -32022, "Unsupported protocol version $version", data)
    }
    if (message.id == null) return@WebHandler WebResponse(200, mapOf("Content-Type" to "application/json"))
    val metaVersion = message.protocolVersion ?: return@WebHandler rpcError(400, id, -32602, "Required request metadata is missing")
    if (metaVersion != JsonPrimitive(version)) {
        return@WebHandler rpcError(400, id, -32020, "MCP-Protocol-Version header does not match request metadata")
    }

    context.with(request) { each ->
        app.openSession(settings.target, each, settings.session).use { session ->
            answer(session, message, id, settings, settings.instructions ?: app.description)
        }
    }
}

/** The members of a JSON-RPC request that the server reads. A request with no `id` is a notification. */
private class JsonRpcRequest(
    /** The id: a string, a number, or `null` for any other value. `null` when the request has no `id`. */
    val id: JsonElement?,
    val method: String?,
    val name: String?,
    val arguments: JsonElement?,
    val protocolVersion: JsonElement?,
) {
    companion object {
        fun of(body: JsonElement): JsonRpcRequest {
            val obj = body as? JsonObject ?: return JsonRpcRequest(null, null, null, null, null)
            val params = obj.obj("params")
            val id = obj["id"]?.let { value -> if (value is JsonPrimitive && value !is JsonNull) value else JsonNull }
            return JsonRpcRequest(
                id = id,
                method = obj.string("method"),
                name = params?.string("name"),
                arguments = params?.get("arguments"),
                protocolVersion = params?.obj("_meta")?.get("io.modelcontextprotocol/protocolVersion"),
            )
        }
    }
}

private suspend fun answer(session: Session<*>, message: JsonRpcRequest, id: JsonElement, settings: McpSettings, instructions: String?): WebResponse {
    fun complete(result: JsonObject, list: Boolean = false) = reply(
        id,
        buildJsonObject {
            putJsonObject("_meta") {
                putJsonObject("io.modelcontextprotocol/serverInfo") {
                    put("name", settings.name)
                    put("version", settings.version)
                }
            }
            put("resultType", "complete")
            if (list) {
                put("ttlMs", 0)
                put("cacheScope", "private")
            }
            result.forEach { (key, value) -> put(key, value) }
        },
    )
    return when (message.method) {
        "server/discover" -> complete(
            buildJsonObject {
                put("supportedVersions", buildJsonArray { add(JsonPrimitive(MCP_PROTOCOL_VERSION)) })
                putJsonObject("capabilities") { putJsonObject("tools") { put("listChanged", false) } }
                instructions?.let { put("instructions", it) }
            },
            list = true,
        )
        "tools/list" -> complete(buildJsonObject { put("tools", listTools(session)) }, list = true)
        "tools/call" -> {
            val name = message.name.orEmpty()
            val handle = session.handles[name]
            if (handle == null || !handle.availability.value.available) {
                return rpcError(200, id, MCP_UNKNOWN_TOOL, "Tool '$name' not found")
            }
            val outcome = session.invoke(name, message.arguments ?: JsonObject(emptyMap()))
            complete(mcpToolResult(outcome, hasObjectOutput(session, name)))
        }
        else -> rpcError(404, id, -32601, "Method not found: ${message.method}")
    }
}

private fun listTools(session: Session<*>): JsonArray {
    val types = session.view.obj("\$defs").orEmpty()
    val capabilities = session.view.obj("capabilities").orEmpty()
    return JsonArray(
        session.handles.values.filter { it.availability.value.available }.map { handle ->
            val capability = capabilities.obj(handle.id) ?: throw IllegalStateException("The view of the session has no capability ${handle.id}.")
            val output = capability["output"]?.let { bundle(it, types) }
            buildJsonObject {
                put("name", handle.id)
                put("description", capability.string("description").orEmpty())
                put("inputSchema", bundle(capability["input"] ?: JsonObject(mapOf("type" to JsonPrimitive("object"))), types))
                if ((output as? JsonObject)?.string("type") == "object") put("outputSchema", output)
                putJsonObject("annotations") { put("readOnlyHint", capability.boolean("readOnly") == true) }
            }
        },
    )
}

private fun hasObjectOutput(session: Session<*>, id: String): Boolean {
    val output = session.view.obj("capabilities")?.obj(id)?.get("output") ?: return false
    return (bundle(output, session.view.obj("\$defs").orEmpty()) as? JsonObject)?.string("type") == "object"
}

/** The MCP tool result for an outcome that is not `unknown-capability`. */
public fun mcpToolResult(outcome: Outcome, hasOutputSchema: Boolean): JsonObject {
    fun text(value: JsonElement) = buildJsonArray {
        add(
            buildJsonObject {
                put("type", "text")
                put("text", jsonText(value))
            },
        )
    }
    return when (outcome) {
        is Outcome.Failed -> buildJsonObject {
            put("content", text(outcome.failure.toJson()))
            put("isError", true)
        }
        is Outcome.Completed -> when (val result = outcome.result) {
            is Result.Failed -> buildJsonObject {
                put("content", text(result.toJson()))
                put("isError", true)
            }
            is Result.Ok -> buildJsonObject {
                put("content", text(result.value))
                if (hasOutputSchema) put("structuredContent", result.value)
            }
        }
    }
}

private fun reply(id: JsonElement, result: JsonObject): WebResponse = WebResponse.json(
    200,
    jsonText(
        buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("result", result)
        },
    ),
)

private fun rpcError(status: Int, id: JsonElement, code: Int, message: String, data: JsonObject? = null): WebResponse = WebResponse.json(
    status,
    jsonText(
        buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            putJsonObject("error") {
                put("code", code)
                put("message", message)
                data?.let { put("data", it) }
            }
        },
    ),
)

/** The HTTP status and the JSON-RPC error code of each rejected MCP request. */
private fun mcpRejection(rejection: Rejection): WebResponse {
    val headers = rejectionHeaders(rejection, allow = "POST")
    val (status, code) = when (rejection) {
        Rejection.Method -> 405 to null
        Rejection.Origin -> 403 to null
        Rejection.MediaType -> 415 to null
        Rejection.TooLarge -> 413 to -32600
        Rejection.NotUtf8 -> 400 to -32700
    }
    if (code == null) return WebResponse(status, headers)
    val message = if (rejection == Rejection.TooLarge) "The request body is too large." else "The request body is not UTF-8 JSON."
    return WebResponse.json(
        status,
        jsonText(
            buildJsonObject {
                put("jsonrpc", "2.0")
                put("id", JsonNull)
                putJsonObject("error") {
                    put("code", code)
                    put("message", message)
                }
            },
        ),
        headers,
    )
}
