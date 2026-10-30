/*
 * The command line of the air conditioner: `aircon power set --on`, `aircon schedule set --days mon --days fri`.
 */
package dev.acidcat.example.aircon

import dev.acidcat.core.CliSettings
import dev.acidcat.core.cliMain

public fun main(args: Array<String>) {
    cliMain(aircon, CliSettings(name = "aircon", version = "0.1.0", context = AirConditioner()), args)
}
