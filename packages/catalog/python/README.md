# acid-cat-catalog

The AcidCat catalog library for Python. PyPI package: `acid-cat-catalog`.

Write a catalog in Python, and write it in canonical form. The library uses only the standard library. Use it at build time to write `acidcat.catalog.json`.

```sh
pip install acid-cat-catalog
```

```python
from pathlib import Path
from acid_cat_catalog import Catalog

catalog = Catalog(title="Hilltop weather station")
catalog.target("logger", bindings=["http"])
fault = catalog.type("SensorFault", {"type": "object"})
catalog.capability(
    "weather.sensor.calibrate",
    description="Correct one sensor by a fixed offset.",
    audience=["logger"],
    input={"type": "object", "required": ["offset"], "properties": {"offset": {"type": "number"}}},
    failures={"SensorFault": fault},
)
catalog.event(
    "weather.alert.raised",
    description="A reading passed a limit. The occurrence gives the reading.",
    audience=["logger"],
    input={"type": "object", "properties": {}},
    payload={"type": "object", "properties": {"celsius": {"type": "number"}}},
)

Path("acidcat.catalog.json").write_text(catalog.render())
```

`event()` declares an [event](../../../spec/events.md): clients subscribe to it, and get its payload in each occurrence. A payload is an object, or a reference to a type that is an object. `validate()` lists the rules a catalog breaks, and `render()` raises `CatalogError` for one that breaks any. The full example is [`examples/weather.py`](examples/weather.py), a weather station.

The tests compare the output of the library with files in this directory: the weather-station catalog [`examples/weather.acidcat.json`](examples/weather.acidcat.json), and a catalog of values that languages write differently, [`tests/fixtures/edge.acidcat.json`](tests/fixtures/edge.acidcat.json). The air-conditioner example of the repository also writes its catalog with this library, in [`examples/aircon/catalog/python.py`](../../../examples/aircon/catalog/python.py). Its test compares the output with the Pkl catalog. Each committed catalog file is in [canonical form](../../../spec/catalog.md#canonical-form), and the root `moon run check` checks this. Thus all catalog libraries agree on the canonical form, and they do not share a test file. Test with `moon run catalog-python:test`.
