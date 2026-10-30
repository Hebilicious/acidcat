/*
 * The command line of the fixture, for `acid-cat conform --cli`. It writes the file of a marker.
 */
package dev.acidcat.fixture

import dev.acidcat.core.CliSettings
import dev.acidcat.core.SessionOptions
import dev.acidcat.core.cliMain
import java.io.File

public fun main(args: Array<String>) {
    val context = FixtureContext(holds = Holds(mark = { path -> File(path).writeText("") }))
    cliMain(fixture, CliSettings(name = "fixture", version = "0.0.0", context = context, session = SessionOptions(onDefect = { _, _ -> })), args)
}
