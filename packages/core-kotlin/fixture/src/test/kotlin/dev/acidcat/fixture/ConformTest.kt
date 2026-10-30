package dev.acidcat.fixture

import dev.acidcat.core.HttpSettings
import dev.acidcat.core.McpSettings
import dev.acidcat.core.SessionOptions
import dev.acidcat.core.httpHandler
import dev.acidcat.core.mcpHandler
import dev.acidcat.ktor.serve
import io.ktor.server.engine.embeddedServer
import io.ktor.server.netty.Netty
import io.ktor.server.routing.route
import io.ktor.server.routing.routing
import kotlinx.coroutines.runBlocking
import java.io.File
import java.nio.file.Files
import java.util.concurrent.TimeUnit
import kotlin.test.Test
import kotlin.test.assertEquals

/** Run `acid-cat conform` against the MCP, HTTP and CLI bindings of the fixture. */
class ConformTest {
    private val repository = File(System.getProperty("acidcat.repository"))

    @Test
    fun `the Kotlin core passes acid-cat conform through its MCP, HTTP and CLI bindings`() {
        val quiet = SessionOptions(onDefect = { _, _ -> })
        val context = FixtureContext()
        val server = embeddedServer(Netty, port = 0, host = "127.0.0.1") {
            routing {
                route("/mcp") {
                    serve(mcpHandler(fixture, McpSettings(name = "fixture", version = "0.0.0", allowedOrigins = emptyList(), session = quiet), context))
                }
                route("/api") {
                    serve(httpHandler(fixture, HttpSettings(allowedOrigins = emptyList(), base = "/api", session = quiet), context))
                }
            }
        }.start(wait = false)
        try {
            val port = runBlocking { server.engine.resolvedConnectors().first().port }
            val url = "http://127.0.0.1:$port"
            val output = conform("--mcp", "$url/mcp", "--http", "$url/api", "--cli", cliLauncher().path)
            assertEquals(0, output.first, output.second)
        } finally {
            server.stop(0, 0)
        }
    }

    /** A script that starts the command line of the fixture with the class path of the tests. */
    private fun cliLauncher(): File {
        val script = Files.createTempFile("fixture-cli", ".sh").toFile()
        val java = File(System.getProperty("java.home"), "bin/java").path
        script.writeText("#!/bin/sh\nexec '$java' -cp '${System.getProperty("java.class.path")}' dev.acidcat.fixture.FixtureCliKt \"\$@\"\n")
        script.setExecutable(true)
        script.deleteOnExit()
        return script
    }

    /** Run `acid-cat conform` with Node, and give its exit code and its output. */
    private fun conform(vararg args: String): Pair<Int, String> {
        val main = repository.resolve("packages/cli/src/main.ts").path
        val process = ProcessBuilder(listOf("node", main, "conform", *args))
            .directory(repository)
            .redirectErrorStream(true)
            .start()
        val output = process.inputStream.bufferedReader().readText()
        check(process.waitFor(10, TimeUnit.MINUTES)) { "acid-cat conform did not end." }
        return process.exitValue() to output
    }
}
