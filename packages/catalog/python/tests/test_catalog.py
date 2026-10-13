import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "examples"))

from acid_cat_catalog import Catalog, CatalogError  # noqa: E402
from aircon import aircon_catalog  # noqa: E402

CATALOG = HERE.parent.parent
ROOT = CATALOG.parent.parent


class CatalogTest(unittest.TestCase):
    def test_writes_the_same_aircon_catalog_as_pkl(self) -> None:
        expected = (ROOT / "examples" / "aircon.acidcat.json").read_text(encoding="utf-8")
        self.assertEqual(aircon_catalog().render(), expected)

    def test_writes_the_canonical_form_of_every_value(self) -> None:
        catalog = Catalog().target("cli", bindings=["cli"])
        catalog.capability(
            "edge.case.check",
            description='Strings: "quoted", back\\slash, tab\t, é, \u2028, \u0001, 😀.',
            audience=["cli"],
            output={
                "type": "object",
                "zKey": "last",
                "aKey": "first",
                "properties": {"é": {"type": "string"}, "z": {"type": "string"}, "Z": {"type": "string"}},
                "examples": [
                    {
                        "whole": 16.0,
                        "half": 0.5,
                        "tiny": 1e-7,
                        "small": 0.000001,
                        "large": 1e21,
                        "big": 123456789012345680000.0,
                        "negative": -2.5e-10,
                        "zero": 0,
                        "integer": 42,
                    }
                ],
            },
        )
        expected = (CATALOG / "fixtures" / "edge.acidcat.json").read_text(encoding="utf-8")
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
