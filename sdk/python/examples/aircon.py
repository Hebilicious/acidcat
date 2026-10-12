"""The air-conditioner catalog (examples/aircon.pkl), written with the Python SDK."""

import sys
from pathlib import Path

sys.path.insert(0, str(Path(__file__).resolve().parent.parent))

from acidcat import Catalog, Schema  # noqa: E402


def aircon_catalog() -> Catalog:
    catalog = Catalog(
        title="Living-room air conditioner",
        description="Control and monitor one split-unit air conditioner on the home network.",
    )

    catalog.target(
        "app",
        description="The phone, desktop and web apps that people use.",
        bindings=["typescript", "acme:swift", "acme:kotlin"],
    )
    catalog.target(
        "taskbar",
        description="A desktop taskbar widget showing the status and a power toggle.",
        bindings=["typescript"],
    )
    catalog.target("cli", bindings=["cli"])
    catalog.target("mcp", description="Agents, through an MCP server.", bindings=["mcp"])
    catalog.target("api", description="Home-automation systems and scripts.", bindings=["http", "graphql"])

    mode = catalog.type("Mode", {"enum": ["cool", "heat", "dry", "fan", "auto"]})
    fan_speed = catalog.type("FanSpeed", {"enum": ["auto", "low", "medium", "high"]})
    status = catalog.type(
        "Status",
        {
            "type": "object",
            "required": ["power", "mode", "fan", "targetCelsius", "roomCelsius"],
            "properties": {
                "power": {"type": "boolean"},
                "mode": mode,
                "fan": fan_speed,
                "targetCelsius": {"type": "number"},
                "roomCelsius": {"type": "number"},
            },
        },
    )
    offline = catalog.type(
        "Offline",
        {"type": "object", "properties": {"since": {"type": "string", "format": "date-time"}}},
    )

    everywhere = ["app", "taskbar", "cli", "mcp", "api"]
    controls = ["app", "cli", "mcp", "api"]

    def setting(name: str, prop: Schema) -> Schema:
        return {"type": "object", "required": [name], "properties": {name: prop}}

    catalog.capability(
        "aircon.status.get",
        description="Read the unit's power, mode, fan speed, target temperature and room temperature.",
        audience=everywhere,
        output=status,
        failures={"Offline": offline},
        read_only=True,
        state=status,
    )
    catalog.capability(
        "aircon.power.set",
        description="Turn the unit on or off.",
        audience=everywhere,
        input=setting("on", {"type": "boolean"}),
        failures={"Offline": offline},
    )
    catalog.capability(
        "aircon.mode.set",
        description="Choose how the unit runs.",
        audience=controls,
        input=setting("mode", mode),
        failures={
            "Offline": offline,
            "PoweredOff": {"type": "object", "description": "The unit must be on before its mode can change."},
        },
    )
    catalog.capability(
        "aircon.temperature.set",
        description="Set the target temperature in degrees Celsius.",
        audience=controls,
        input=setting("celsius", {"type": "number", "minimum": 16, "maximum": 31}),
        failures={"Offline": offline},
    )
    catalog.capability(
        "aircon.fan.set",
        description="Set the fan speed.",
        audience=controls,
        input=setting("speed", fan_speed),
        failures={"Offline": offline},
    )
    catalog.capability(
        "aircon.firmware.update",
        description="Install the latest firmware. The unit restarts and is offline for about a minute.",
        audience=["app"],
        failures={"Offline": offline, "UpToDate": {"type": "object", "properties": {"version": {"type": "string"}}}},
    )
    return catalog


if __name__ == "__main__":
    sys.stdout.write(aircon_catalog().render())
