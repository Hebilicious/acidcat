package dev.acidcat.core

import kotlinx.coroutines.runBlocking
import kotlinx.serialization.json.JsonArray
import kotlinx.serialization.json.JsonObject
import kotlin.test.Test
import kotlin.test.assertEquals
import kotlin.test.assertTrue

/** The CLI, HTTP and MCP bindings, called in the same process. `acid-cat conform` tests them from outside too. */
class BindingsTest {
    private val quiet = SessionOptions(onDefect = { _, _ -> })

    private fun cli(vararg args: String): Triple<Int, String, String> = runBlocking {
        val out = StringBuilder()
        val err = StringBuilder()
        val code = runCli(kettleApp, CliSettings(name = "kettle", version = "1.0.0", context = Kettle(), session = quiet), args.toList(), CliIo({ out.appendLine(it) }, { err.appendLine(it) }))
        Triple(code, out.toString(), err.toString())
    }

    @Test
    fun `the command line has a command for each capability of the view, with flags`() {
        val (code, out) = cli("kettle", "water", "fill", "--litres", "0.5")
        assertEquals(0, code)
        assertTrue("\"litres\": 1.5" in out)
        assertEquals(1, cli("kettle", "water", "fill", "--litres=1.2").first)
        assertEquals(3, cli("kettle", "water", "fill", "--litres", "many").first)
        assertEquals(3, cli("kettle", "water", "fill").first)
        assertEquals(2, cli("kettle", "boil").first)
        assertEquals(0, cli("kettle", "hidden").first)
    }

    @Test
    fun `list gives the usage of each capability`() {
        val (code, out) = cli("list")
        assertEquals(0, code)
        val list = AcidCatJson.parseToJsonElement(out) as JsonArray
        val usages = list.associate { (it as JsonObject).string("id") to it.string("usage") }
        assertEquals("kettle kettle water fill --litres <number>", usages["kettle.water.fill"])
        assertEquals("kettle kettle hidden", usages["kettle.hidden"])
    }

    @Test
    fun `a command of the application must not take the name of another command`() {
        val settings = CliSettings(name = "kettle", version = "1", context = Kettle(), commands = listOf(CliCommand<Kettle>("list", "d") { _, _, _ -> 0 }))
        val error = runCatching { runBlocking { runCli(kettleApp, settings, emptyList(), CliIo({}, {})) } }.exceptionOrNull()
        assertTrue(error is IllegalStateException)
    }

    private fun request(method: String, path: String, body: String = "", headers: Map<String, String> = mapOf("content-type" to "application/json")): WebRequest {
        var sent = false
        return WebRequest(method, path, headers, RequestBody { if (sent || body.isEmpty()) null else body.toByteArray().also { sent = true } })
    }

    @Test
    fun `the HTTP binding gives outcomes with their status codes`() = runBlocking {
        val handler = httpHandler(kettleApp, HttpSettings(allowedOrigins = emptyList(), target = "app", session = quiet), Kettle())
        assertEquals(200, handler.handle(request("POST", "/capabilities/kettle.water.fill", """{"litres":0.5}""")).status)
        assertEquals(422, handler.handle(request("POST", "/capabilities/kettle.water.fill", """{"litres":5}""")).status)
        assertEquals(404, handler.handle(request("POST", "/capabilities/kettle.hidden", "{}")).status)
        assertEquals(500, handler.handle(request("POST", "/capabilities/kettle.broken", "{}")).status)
        assertEquals(405, handler.handle(request("PUT", "/capabilities", "{}")).status)
        assertEquals(415, handler.handle(request("POST", "/capabilities/kettle.boil", "{}", mapOf("content-type" to "text/plain"))).status)
        assertEquals(403, handler.handle(request("GET", "/capabilities", headers = mapOf("origin" to "https://elsewhere.example"))).status)
        assertEquals(400, handler.handle(WebRequest("POST", "/capabilities/kettle.boil", mapOf("content-type" to "application/json"), oneChunk(byteArrayOf(0xC3.toByte())))).status)
    }

    @Test
    fun `a body over the limit is rejected as it arrives`() = runBlocking {
        val handler = httpHandler(kettleApp, HttpSettings(allowedOrigins = emptyList(), target = "app", maximumBytes = 4, session = quiet), Kettle())
        assertEquals(413, handler.handle(request("POST", "/capabilities/kettle.water.fill", """{"litres":0.5}""")).status)
    }

    @Test
    fun `the MCP binding lists the available tools of the view`() = runBlocking {
        val handler = mcpHandler(kettleApp, McpSettings(name = "kettle", version = "1", allowedOrigins = emptyList(), target = "app", session = quiet), Kettle())
        val body = """{"jsonrpc":"2.0","id":1,"method":"tools/list","params":{"_meta":{"io.modelcontextprotocol/protocolVersion":"$MCP_PROTOCOL_VERSION"}}}"""
        val response = handler.handle(request("POST", "/mcp", body, mapOf("content-type" to "application/json", "mcp-protocol-version" to MCP_PROTOCOL_VERSION)))
        assertEquals(200, response.status)
        val tools = (AcidCatJson.parseToJsonElement(checkNotNull(response.body).decodeToString()) as JsonObject).obj("result")?.get("tools") as JsonArray
        assertEquals(listOf("kettle.water.fill", "kettle.boil", "kettle.stubborn", "kettle.broken"), tools.map { (it as JsonObject).string("name") })
    }

    private fun oneChunk(bytes: ByteArray): RequestBody {
        var sent = false
        return RequestBody { if (sent) null else bytes.also { sent = true } }
    }
}
