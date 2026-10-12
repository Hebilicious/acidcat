import json
import sys
import unittest
from pathlib import Path

HERE = Path(__file__).resolve().parent
sys.path.insert(0, str(HERE.parent))
sys.path.insert(0, str(HERE.parent / "examples"))

from acidcat import Catalog, CatalogError  # noqa: E402
from aircon import aircon_catalog  # noqa: E402

EXPECTED = HERE.parent.parent.parent / "examples" / "aircon.acidcat.json"


class CatalogTest(unittest.TestCase):
    def test_writes_the_same_aircon_catalog_as_pkl(self) -> None:
        self.assertEqual(json.loads(aircon_catalog().render()), json.loads(EXPECTED.read_text()))

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
