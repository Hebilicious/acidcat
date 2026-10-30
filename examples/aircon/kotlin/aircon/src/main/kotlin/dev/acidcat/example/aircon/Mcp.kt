/*
 * The MCP server of the air conditioner through stdio. An MCP client starts it as a process.
 */
package dev.acidcat.example.aircon

import dev.acidcat.core.McpStdioSettings
import dev.acidcat.core.mcpStdioMain

public fun main() {
    mcpStdioMain(aircon, McpStdioSettings(name = "aircon", version = "0.1.0"), AirConditioner())
}
