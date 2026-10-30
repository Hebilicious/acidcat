/*
 * Write the catalog of the fixture, in canonical form, to the file that the arguments name.
 */
package dev.acidcat.fixture

import java.io.File

public object WriteCatalog {
    @JvmStatic
    public fun main(args: Array<String>) {
        File(args.single()).writeText(fixture.renderCatalog())
    }
}
