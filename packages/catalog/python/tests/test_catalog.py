import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "examples"))

from acid_cat_catalog import Catalog, CatalogError, canonical_text  # noqa: E402
from weather import weather_catalog  # noqa: E402

PACKAGE = HERE.parent
TESTDATA = PACKAGE.parent / "testdata"


class CatalogTest(unittest.TestCase):
    def test_writes_the_weather_catalog_in_canonical_form(self) -> None:
        expected = (PACKAGE / "examples" / "weather.acidcat.json").read_text(encoding="utf-8")
        self.assertEqual(weather_catalog().render(), expected)

    def test_writes_every_value_of_the_shared_test_catalog(self) -> None:
        catalog = json.loads((TESTDATA / "canonical.json").read_text(encoding="utf-8"))
        expected = (TESTDATA / "canonical.acidcat.json").read_text(encoding="utf-8")
        self.assertEqual(canonical_text(catalog), expected)

    def test_writes_the_hints_of_a_capability_in_canonical_order(self) -> None:
        catalog = Catalog().target("agents", surfaces=["mcp"])
        catalog.capability(
            "notes.count.read",
            state={"type": "integer"},
            idempotent=True,
            destructive=False,
            read_only=True,
            audience=["agents"],
            description="Read the number of notes.",
        )
        expected = (TESTDATA / "hints.acidcat.json").read_text(encoding="utf-8")
        self.assertEqual(catalog.render(), expected)

    def test_reports_the_rules_a_catalog_breaks(self) -> None:
        catalog = (
            Catalog()
            .target("cli", surfaces=["cli"])
            .capability("Bad.Id", description="x")
            .capability("a.b", description="y", audience=["clii"])
            .capability("a.c", description="z", input={"type": "string"})
            .capability("a.d", description="w", output={"$ref": "#/$defs/Nope"})
        )
        self.assertEqual(
            catalog.validate(),
            [
                "the id Bad.Id is malformed",
                "a.b names the undeclared target clii",
                "a.c input does not describe an object",
                "a.d references #/$defs/Nope, which is not a type",
            ],
        )
        with self.assertRaises(CatalogError):
            catalog.render()

    def test_reports_the_rules_an_event_breaks(self) -> None:
        catalog = Catalog().target("cli", surfaces=["cli"])
        catalog.type("Name", {"type": "string"})
        catalog.capability("a.b", description="x")
        catalog.event("a.b", description="y")
        catalog.event("a.c", description="z", audience=["clii"], input={"type": "string"})
        catalog.event("a.d", description="w", payload={"$ref": "#/$defs/Name"})
        catalog.event("a.e", description="v", payload={"type": "object", "$defs": {}})
        self.assertEqual(
            catalog.validate(),
            [
                "a.b is both a capability and an event",
                "a.c names the undeclared target clii",
                "a.c input does not describe an object",
                "a.d payload does not describe an object",
                "a.e carries its own $defs; declare shared types with type()",
            ],
        )

    def test_reports_a_boolean_schema(self) -> None:
        catalog = Catalog().target("cli", surfaces=["cli"])
        catalog.type("Anything", True)
        catalog.capability("a.b", description="x", input=True, output=True, failures={"Gone": False}, state=True)
        catalog.event("a.c", description="y", input=False, payload=True)
        catalog.capability("a.d", description="z", output={"type": "object", "additionalProperties": False, "items": True})
        self.assertEqual(
            catalog.validate(),
            [
                "the type Anything is not a JSON object",
                "a.b input is not a JSON object",
                "a.b output is not a JSON object",
                "a.b state is not a JSON object",
                "a.b failure Gone is not a JSON object",
                "a.c input is not a JSON object",
                "a.c payload is not a JSON object",
            ],
        )


if __name__ == "__main__":
    unittest.main()
