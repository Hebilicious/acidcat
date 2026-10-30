/*
 * The MCP server of the fixture through stdio, for `acid-cat conform --mcp-stdio`.
 */
package dev.acidcat.fixture

import dev.acidcat.core.McpStdioSettings
import dev.acidcat.core.SessionOptions
import dev.acidcat.core.mcpStdioMain

public fun main() {
    mcpStdioMain(fixture, McpStdioSettings(name = "fixture", version = "0.0.0", session = SessionOptions(onDefect = { _, _ -> })), FixtureContext())
}
