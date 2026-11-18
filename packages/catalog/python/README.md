# acid-cat-catalog

The AcidCat catalog library for Python, published on PyPI as `acid-cat-catalog`. Build a catalog in code and write it in [canonical form](../../../spec/catalog.md#canonical-form). The library uses only the standard library. Use it at build time to write `acidcat.catalog.json`.

## Install

```sh
pip install acid-cat-catalog
```

## Example

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

The full example, a weather station, is [`examples/weather.py`](examples/weather.py).

## API

- `event()` declares an [event](../../../spec/events.md). Clients subscribe to it and get its payload in each occurrence. A payload is an object, or a reference to a type that is an object.
- `read_only`, `destructive` and `idempotent` are a capability's [hints](../../../spec/catalog.md#capabilities) for clients. A hint you leave out is not in the catalog.
- `validate()` lists the rules that the catalog breaks. `render()` raises `CatalogError` for a catalog that breaks any rule.

## Tests

Run `moon run catalog-python:test`. The tests compare the library's output, byte for byte, with these files:

| File | Contents |
| --- | --- |
| [`examples/weather.acidcat.json`](examples/weather.acidcat.json) | The weather-station catalog |
| [`tests/fixtures/edge.acidcat.json`](tests/fixtures/edge.acidcat.json) | Values that languages write differently by default |
| [`tests/fixtures/hints.acidcat.json`](tests/fixtures/hints.acidcat.json) | Each hint of a capability, in canonical order |

The air-conditioner example writes its catalog with this library in [`examples/aircon/catalog/python.py`](../../../examples/aircon/catalog/python.py), and its test compares the output with the Pkl catalog. The root `moon run check` checks that each committed catalog file is in canonical form, so the catalog libraries agree on the form without sharing a test file.
