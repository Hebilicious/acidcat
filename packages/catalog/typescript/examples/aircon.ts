/** The air-conditioner catalog (examples/aircon.pkl), written with the TypeScript catalog library. */
import { Catalog, type Schema } from "../src/index.ts";

export function airconCatalog(): Catalog {
  const catalog = new Catalog({
    title: "Living-room air conditioner",
    description: "Control and monitor one split-unit air conditioner on the home network.",
  });

  catalog
    .target("app", {
      description: "The phone, desktop and web apps that people use.",
      bindings: ["typescript", "acme:swift", "acme:kotlin"],
    })
    .target("taskbar", {
      description: "A desktop taskbar widget showing the status and a power toggle.",
      bindings: ["typescript"],
    })
    .target("cli", { bindings: ["cli"] })
    .target("mcp", { description: "Agents, through an MCP server.", bindings: ["mcp"] })
    .target("api", { description: "Home-automation systems and scripts.", bindings: ["http", "graphql"] });

  const mode = catalog.type("Mode", { enum: ["cool", "heat", "dry", "fan", "auto"] });
  const fanSpeed = catalog.type("FanSpeed", { enum: ["auto", "low", "medium", "high"] });
  const status = catalog.type("Status", {
    type: "object",
    required: ["power", "mode", "fan", "targetCelsius", "roomCelsius"],
    properties: {
      power: { type: "boolean" },
      mode,
      fan: fanSpeed,
      targetCelsius: { type: "number" },
      roomCelsius: { type: "number" },
    },
  });
  const offline = catalog.type("Offline", {
    type: "object",
    properties: { since: { type: "string", format: "date-time" } },
  });

  const everywhere = ["app", "taskbar", "cli", "mcp", "api"];
  const controls = ["app", "cli", "mcp", "api"];
  const setting = (name: string, property: Schema) => ({
    input: { type: "object", required: [name], properties: { [name]: property } },
    failures: { Offline: offline },
  });

  return catalog
    .capability("aircon.status.get", {
      description: "Read the unit's power, mode, fan speed, target temperature and room temperature.",
      audience: everywhere,
      output: status,
      failures: { Offline: offline },
      readOnly: true,
      state: status,
    })
    .capability("aircon.power.set", {
      description: "Turn the unit on or off.",
      audience: everywhere,
      ...setting("on", { type: "boolean" }),
    })
    .capability("aircon.mode.set", {
      description: "Choose how the unit runs.",
      audience: controls,
      input: setting("mode", mode).input,
      failures: {
        Offline: offline,
        PoweredOff: { type: "object", description: "The unit must be on before its mode can change." },
      },
    })
    .capability("aircon.temperature.set", {
      description: "Set the target temperature in degrees Celsius.",
      audience: controls,
      ...setting("celsius", { type: "number", minimum: 16, maximum: 31 }),
    })
    .capability("aircon.fan.set", {
      description: "Set the fan speed.",
      audience: controls,
      ...setting("speed", fanSpeed),
    })
    .capability("aircon.firmware.update", {
      description: "Install the latest firmware. The unit restarts and is offline for about a minute.",
      audience: ["app"],
      failures: { Offline: offline, UpToDate: { type: "object", properties: { version: { type: "string" } } } },
    });
}

if (import.meta.main) process.stdout.write(airconCatalog().render());
