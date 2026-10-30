package dev.acidcat.fixture

import java.io.File
import kotlin.test.Test
import kotlin.test.assertEquals

class CatalogTest {
    @Test
    fun `the committed catalog of the fixture is the catalog that the core writes`() {
        val committed = File(System.getProperty("acidcat.repository"), "packages/core-kotlin/fixture/fixture.acidcat.json")
        assertEquals(committed.readText(), fixture.renderCatalog(), "Run `moon run core-kotlin:catalog`, then commit fixture/fixture.acidcat.json.")
    }
}
