/*
 * The MCP binding through standard input and standard output (spec/bindings/mcp.md#stdio). The process is one session.
 * The server serves revision 2026-07-28, and the `initialize` handshake of revisions 2025-11-25 and 2025-06-18.
 */
package dev.acidcat.core

import kotlinx.coroutines.CoroutineScope
import kotlinx.coroutines.CoroutineStart
import kotlinx.coroutines.Dispatchers
import kotlinx.coroutines.Job
import kotlinx.coroutines.cancelAndJoin
import kotlinx.coroutines.coroutineScope
import kotlinx.coroutines.flow.Flow
import kotlinx.coroutines.flow.flow
import kotlinx.coroutines.flow.flowOn
import kotlinx.coroutines.launch
import kotlinx.coroutines.runBlocking
import kotlinx.serialization.SerializationException
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonElement
import kotlinx.serialization.json.JsonNull
import kotlinx.serialization.json.JsonObject
import kotlinx.serialization.json.JsonPrimitive
import kotlinx.serialization.json.buildJsonObject
import kotlinx.serialization.json.put
import kotlinx.serialization.json.putJsonObject
import kotlin.system.exitProcess

/** The settings of the MCP binding through stdio. */
public class McpStdioSettings(
    public val name: String,
    public val version: String,
    /** Guidance for a model about the whole server. The default is the description of the application. */
    public val instructions: String? = null,
    /** The target that the server serves. */
    public val target: String = "mcp",
    public val session: SessionOptions = SessionOptions(),
)

/** The revisions with an `initialize` handshake that the server serves, the latest first. */
private val HANDSHAKE_VERSIONS = listOf("2025-11-25", "2025-06-18")

private val SUPPORTED_VERSIONS = listOf(MCP_PROTOCOL_VERSION) + HANDSHAKE_VERSIONS

private const val PROTOCOL_VERSION_KEY = "io.modelcontextprotocol/protocolVersion"
private const val SUBSCRIPTION_ID_KEY = "io.modelcontextprotocol/subscriptionId"

/**
 * Serve the MCP server on `lines`, one JSON-RPC message on each line, until the lines end. Then the session closes:
 * the calls in progress are cancelled, and the function returns. `write` writes one line of standard output, without
 * its newline. The server calls it from one coroutine at a time.
 */
public suspend fun <Context> runMcpStdio(app: App<Context>, settings: McpStdioSettings, context: Context, lines: Flow<String>, write: (String) -> Unit) {
    val session = app.openSession(settings.target, context, settings.session)
    coroutineScope {
        val server = StdioServer(session, settings, settings.instructions ?: app.description, write, this)
        val changes = launch(start = CoroutineStart.UNDISPATCHED) { session.changes.collect { server.announce() } }
        try {
            lines.collect { server.receive(it) }
        } finally {
            changes.cancel()
            server.close()
            session.close()
        }
    }
}

/**
 * Run the MCP server on the standard input and output of the process until standard input ends, then exit. Logs go to
 * standard error, so standard output has only the messages.
 */
public fun <Context> mcpStdioMain(app: App<Context>, settings: McpStdioSettings, context: Context): Nothing {
    val output = System.out
    val stdin = flow {
        val reader = System.`in`.bufferedReader(Charsets.UTF_8)
        while (true) emit(reader.readLine() ?: break)
    }.flowOn(Dispatchers.IO)
    runBlocking {
        runMcpStdio(app, settings, context, stdin) { line ->
            output.print(line)
            output.print('\n')
            output.flush()
        }
    }
    exitProcess(0)
}

/** The state of the one session of the process: the requests in progress, the subscriptions, and the handshake. */
private class StdioServer(
    private val session: Session<*>,
    private val settings: McpStdioSettings,
    private val instructions: String?,
    private val write: (String) -> Unit,
    private val scope: CoroutineScope,
) {
    private val lock = Any()

    /** The calls in progress, by request id. `notifications/cancelled` cancels them. */
    private val calls = mutableMapOf<JsonElement, Job>()

    /** The open `subscriptions/listen` requests of revision 2026-07-28 that asked for tool list changes. */
    private val subscriptions = mutableSetOf<JsonElement>()

    /** True after the `initialize` handshake: the client then gets `notifications/tools/list_changed` with no subscription. */
    @Volatile private var initialized = false
    private var listed = availableIds()

    /** Read one line of standard input. An empty line is ignored. */
    fun receive(line: String) {
        if (line.isBlank()) return
        val body = try {
            AcidCatJson.parseToJsonElement(line)
        } catch (_: SerializationException) {
            return error(JsonNull, -32700, "The line is not JSON.")
        }
        if (body is JsonArray) return error(JsonNull, -32600, "JSON-RPC batches are not supported.")
        if (body !is JsonObject) return error(JsonNull, -32600, "A message must be a JSON object.")
        val method = body.string("method")
        val params = body.obj("params") ?: JsonObject(emptyMap())
        val id = body["id"]?.let { value -> if (value is JsonPrimitive && value !is JsonNull) value else JsonNull }
        if (method == null) {
            // A response of the client. The server sends no requests, so it reads none.
            if (id != null) return
            return error(JsonNull, -32600, "A message must have a method.")
        }
        if (id == null) return notification(method, params)
        request(id, method, params)
    }

    /** Stop the subscriptions, and cancel the calls in progress. */
    suspend fun close() {
        val running = synchronized(lock) {
            subscriptions.clear()
            calls.values.toList()
        }
        running.forEach { it.cancelAndJoin() }
    }

    private fun notification(method: String, params: JsonObject) {
        if (method != "notifications/cancelled") return
        val requestId = params["requestId"] as? JsonPrimitive ?: return
        if (requestId is JsonNull) return
        val call = synchronized(lock) {
            subscriptions.remove(requestId)
            calls[requestId]
        }
        call?.cancel()
    }

    private fun request(id: JsonElement, method: String, params: JsonObject) {
        when (method) {
            "initialize" -> return initialize(id, params["protocolVersion"])
            "ping" -> return result(id, JsonObject(emptyMap()))
        }
        val protocolVersion = params.obj("_meta")?.get(PROTOCOL_VERSION_KEY)
        val modern = protocolVersion != null
        if (modern && protocolVersion != JsonPrimitive(MCP_PROTOCOL_VERSION)) {
            val data = buildJsonObject { put("supported", JsonArray(SUPPORTED_VERSIONS.map(::JsonPrimitive))) }
            return error(id, -32022, "Unsupported protocol version ${jsonText(checkNotNull(protocolVersion))}", data)
        }
        when (method) {
            "server/discover" -> complete(
                id,
                modern,
                buildJsonObject {
                    put("supportedVersions", JsonArray(SUPPORTED_VERSIONS.map(::JsonPrimitive)))
                    putJsonObject("capabilities") { putJsonObject("tools") { put("listChanged", true) } }
                    instructions?.let { put("instructions", it) }
                },
                list = true,
            )
            "subscriptions/listen" -> listen(id, params)
            "tools/list" -> complete(id, modern, buildJsonObject { put("tools", listTools(session)) }, list = true)
            "tools/call" -> call(id, params, modern)
            else -> error(id, -32601, "Method not found: $method")
        }
    }

    /** The `initialize` handshake. The server selects the revision of the client if it serves it, or else its latest. */
    private fun initialize(id: JsonElement, offered: JsonElement?) {
        val version = HANDSHAKE_VERSIONS.firstOrNull { JsonPrimitive(it) == offered } ?: HANDSHAKE_VERSIONS.first()
        result(
            id,
            buildJsonObject {
                put("protocolVersion", version)
                putJsonObject("capabilities") { putJsonObject("tools") { put("listChanged", true) } }
                putJsonObject("serverInfo") {
                    put("name", settings.name)
                    put("version", settings.version)
                }
                instructions?.let { put("instructions", it) }
            },
        )
        initialized = true
    }

    /**
     * A `subscriptions/listen` request of revision 2026-07-28. The server honors only tool list changes. The request stays
     * open until the client cancels it or standard input ends, so the server never answers it.
     */
    private fun listen(id: JsonElement, params: JsonObject) {
        val tools = params.obj("notifications")?.boolean("toolsListChanged") == true && id != JsonNull
        send(
            buildJsonObject {
                put("jsonrpc", "2.0")
                put("method", "notifications/subscriptions/acknowledged")
                putJsonObject("params") {
                    putJsonObject("_meta") { put(SUBSCRIPTION_ID_KEY, id) }
                    putJsonObject("notifications") { if (tools) put("toolsListChanged", true) }
                }
            },
        )
        if (tools) synchronized(lock) { subscriptions += id }
    }

    private fun call(id: JsonElement, params: JsonObject, modern: Boolean) {
        val name = params.string("name").orEmpty()
        val handle = session.handles[name]
        if (handle == null || !handle.availability.value.available) return error(id, MCP_UNKNOWN_TOOL, "Tool '$name' not found")
        val job = scope.launch(start = CoroutineStart.LAZY) {
            // When the client cancels the request, `invoke` throws, and the server does not answer.
            val outcome = session.invoke(name, params["arguments"] ?: JsonObject(emptyMap()))
            complete(id, modern, mcpToolResult(outcome, hasObjectOutput(session, name)))
        }
        if (id != JsonNull) synchronized(lock) { calls[id] = job }
        job.invokeOnCompletion { synchronized(lock) { if (calls[id] === job) calls.remove(id) } }
        job.start()
    }

    /** The ids of the available tools, to compare two sets. */
    private fun availableIds(): List<String> = session.handles.values.filter { it.availability.value.available }.map { it.id }

    /** Tell the client when the set of available tools changes. */
    fun announce() {
        val next = availableIds()
        val listening = synchronized(lock) {
            if (next == listed) return
            listed = next
            subscriptions.toList()
        }
        if (initialized) send(changed(null))
        listening.forEach { send(changed(it)) }
    }

    private fun changed(subscription: JsonElement?) = buildJsonObject {
        put("jsonrpc", "2.0")
        put("method", "notifications/tools/list_changed")
        putJsonObject("params") { if (subscription != null) putJsonObject("_meta") { put(SUBSCRIPTION_ID_KEY, subscription) } }
    }

    /** The result of a request: in revision 2026-07-28, it has the server information and a result type. */
    private fun complete(id: JsonElement, modern: Boolean, result: JsonObject, list: Boolean = false) {
        if (!modern) return result(id, result)
        result(
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
    }

    private fun result(id: JsonElement, result: JsonObject) = send(
        buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            put("result", result)
        },
    )

    private fun error(id: JsonElement, code: Int, message: String, data: JsonObject? = null) = send(
        buildJsonObject {
            put("jsonrpc", "2.0")
            put("id", id)
            putJsonObject("error") {
                put("code", code)
                put("message", message)
                data?.let { put("data", it) }
            }
        },
    )

    /** Write one message on one line. The text of a message has no newline: `jsonText` escapes each one. */
    private fun send(message: JsonObject) = synchronized(lock) { write(jsonText(message)) }
}
