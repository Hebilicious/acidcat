import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "examples"))

from acid_cat_catalog import Catalog, CatalogError  # noqa: E402
from aircon import aircon_catalog  # noqa: E402
from weather import weather_catalog  # noqa: E402

PACKAGE = HERE.parent
ROOT = PACKAGE.parent.parent.parent


class CatalogTest(unittest.TestCase):
    def test_writes_the_same_aircon_catalog_as_pkl(self) -> None:
        expected = (ROOT / "examples" / "aircon.acidcat.json").read_text(encoding="utf-8")
        self.assertEqual(aircon_catalog().render(), expected)

    def test_writes_the_weather_catalog_in_canonical_form(self) -> None:
        expected = (PACKAGE / "examples" / "weather.acidcat.json").read_text(encoding="utf-8")
        self.assertEqual(weather_catalog().render(), expected)

    def test_writes_the_canonical_form_of_every_value(self) -> None:
        catalog = Catalog().target("terminal", bindings=["cli"])
        catalog.capability(
            "edge.numbers.show",
            description='Text: "inner", C:\\temp, cr\r, form\f, nul\u0000, esc\u001b, ls\u2028, ñ, 🌦.',
            audience=["terminal"],
            output={
                "type": "object",
                "mKey": "middle",
                "AKey": "upper",
                "properties": {"ñ": {"type": "string"}, "n": {"type": "string"}, "N": {"type": "string"}, "ō": {"type": "string"}},
                "examples": [
                    {
                        "whole": 3.0,
                        "eighth": 0.125,
                        "tiny": 6.5e-11,
                        "small": 0.00042,
                        "large": 2.5e300,
                        "big": 31415926535897930000.0,
                        "negative": -9.75e-8,
                        "zero": 0.0,
                        "integer": 1013,
                    }
                ],
            },
        )
        expected = (HERE / "fixtures" / "edge.acidcat.json").read_text(encoding="utf-8")
        self.assertEqual(catalog.render(), expected)

    def test_reports_the_rules_a_catalog_breaks(self) -> None:
        catalog = (
            Catalog()
            .target("cli", bindings=["cli"])
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


if __name__ == "__main__":
    unittest.main()
