"""A weather-station catalog, written with the Python catalog library."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from acid_cat_catalog import Catalog  # noqa: E402


def weather_catalog() -> Catalog:
    catalog = Catalog(
        title="Hilltop weather station",
        description="Read the sensors of one outdoor weather station and keep them accurate.",
    )

    catalog.target(
        "dashboard",
        description="The wall screen in the kitchen that shows the weather now.",
        bindings=["typescript"],
    )
    catalog.target(
        "logger",
        description="Scripts that store readings for later study.",
        bindings=["http"],
        options={"basePath": "/station", "rateLimit": {"perMinute": 30}},
    )
    catalog.target("agents", description="Assistants, through an MCP server.", bindings=["mcp"])

    sensor = catalog.type("Sensor", {"enum": ["thermometer", "hygrometer", "barometer", "anemometer"]})
    reading = catalog.type(
        "Reading",
        {
            "type": "object",
            "required": ["at", "celsius", "humidity", "hectopascals"],
            "properties": {
                "at": {"type": "string", "format": "date-time"},
                "celsius": {"type": "number"},
                "humidity": {"type": "number", "minimum": 0, "maximum": 100},
                "hectopascals": {"type": "number"},
                "windKph": {"type": ["number", "null"]},
            },
        },
    )
    sensor_fault = catalog.type(
        "SensorFault",
        {
            "type": "object",
            "required": ["sensor"],
            "properties": {"sensor": sensor, "detail": {"type": "string"}},
        },
    )

    catalog.capability(
        "weather.reading.get",
        description="Read the latest value of every sensor.",
        audience=["dashboard", "logger", "agents"],
        output=reading,
        failures={"SensorFault": sensor_fault},
        read_only=True,
        state=reading,
    )
    catalog.capability(
        "weather.history.list",
        description="List the readings of a past period, one for each hour.",
        audience=["logger", "agents"],
        input={
            "type": "object",
            "required": ["from"],
            "properties": {
                "from": {"type": "string", "format": "date-time"},
                "hours": {"type": "integer", "minimum": 1, "maximum": 168, "default": 24},
                "sensors": {"type": "array", "items": sensor, "uniqueItems": True},
                "withWind": {"type": "boolean"},
            },
        },
        output={"type": "array", "items": reading},
        read_only=True,
    )
    catalog.capability(
        "weather.sensor.calibrate",
        description="Correct one sensor by a fixed offset.",
        audience=["logger"],
        input={
            "type": "object",
            "required": ["sensor", "offset"],
            "properties": {"sensor": sensor, "offset": {"type": "number", "minimum": -5, "maximum": 5}},
        },
        failures={
            "SensorFault": sensor_fault,
            "Busy": {"type": "object", "description": "The station is sending a reading. Try again in a few seconds."},
        },
    )
    return catalog


if __name__ == "__main__":
    sys.stdout.write(weather_catalog().render())
