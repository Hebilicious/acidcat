# acid-cat-catalog

The AcidCat catalog library for Python. PyPI package: `acid-cat-catalog`.

Write a catalog in Python, and write it in canonical form. The library uses only the standard library. Use it at build time to write `acidcat.catalog.json`.

```sh
pip install acid-cat-catalog
```

```python
from pathlib import Path
from acid_cat_catalog import Catalog

catalog = Catalog(title="Living-room air conditioner")
catalog.target("cli", bindings=["cli"])
offline = catalog.type("Offline", {"type": "object"})
catalog.capability(
    "aircon.power.set",
    description="Turn the unit on or off.",
    audience=["cli"],
    input={"type": "object", "required": ["on"], "properties": {"on": {"type": "boolean"}}},
    failures={"Offline": offline},
)

Path("acidcat.catalog.json").write_text(catalog.render())
```

`validate()` lists the rules a catalog breaks, and `render()` raises `CatalogError` for one that breaks any. The full example is [`examples/aircon.py`](examples/aircon.py). Test with `moon run catalog-python:test`.
