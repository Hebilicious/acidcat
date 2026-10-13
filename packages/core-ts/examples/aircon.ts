/**
 * The air conditioner of examples/aircon.pkl, written with @acid-cat/core-ts and Zod. The unit is simulated in memory.
 */
import { z } from "zod";

import { AVAILABLE, capabilitiesFor, defineApp, fail, ok, unavailable } from "../src/index.ts";
import type { Availability, Observable } from "../src/index.ts";

// --- Types -------------------------------------------------------------------------------------------------------

const Mode = z.enum(["cool", "heat", "dry", "fan", "auto"]).meta({ id: "Mode" });
const FanSpeed = z.enum(["auto", "low", "medium", "high"]).meta({ id: "FanSpeed" });
const Status = z
  .object({ power: z.boolean(), mode: Mode, fan: FanSpeed, targetCelsius: z.number(), roomCelsius: z.number() })
  .meta({ id: "Status" });
const Offline = z.object({ _tag: z.literal("Offline"), since: z.string().optional() }).meta({ id: "Offline" });
const PoweredOff = z.object({ _tag: z.literal("PoweredOff") });
const UpToDate = z.object({ _tag: z.literal("UpToDate"), version: z.string() });

// --- The unit ----------------------------------------------------------------------------------------------------

export type State = z.infer<typeof Status> & { online: boolean; firmware: string };

/** The simulated unit. */
export class Unit {
  state: State = { power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25, online: true, firmware: "1.0.0" };
  readonly #listeners = new Set<(value: Availability) => void>();

  /** The availability of the operations that need the unit online. */
  readonly online: Observable<Availability> = {
    getSnapshot: () => (this.state.online ? AVAILABLE : unavailable("The unit is offline.")),
    subscribe: (listener) => {
      this.#listeners.add(listener);
      return { unsubscribe: () => this.#listeners.delete(listener) };
    },
  };

  change(update: Partial<State>) {
    this.state = { ...this.state, ...update };
    this.#listeners.forEach((listener) => listener(this.online.getSnapshot()));
  }
}

export interface Context {
  readonly unit: Unit;
}

const capability = capabilitiesFor<Context>();

/** Change the unit if it is online. */
const change = (unit: Unit, update: Partial<State>) => {
  if (!unit.state.online) return fail("Offline");
  unit.change(update);
  return ok(null);
};

// --- The application ---------------------------------------------------------------------------------------------

const everywhere = ["app", "taskbar", "cli", "mcp", "api"];
const controls = ["app", "cli", "mcp", "api"];

export const aircon = defineApp<Context>({
  title: "Living-room air conditioner",
  description: "Control and monitor one split-unit air conditioner on the home network.",
  targets: {
    app: { description: "The phone, desktop and web apps that people use.", bindings: ["typescript", "acme:swift", "acme:kotlin"] },
    taskbar: { description: "A desktop taskbar widget showing the status and a power toggle.", bindings: ["typescript"] },
    cli: { bindings: ["cli"] },
    mcp: { description: "Agents, through an MCP server.", bindings: ["mcp"] },
    api: { description: "Home-automation systems and scripts.", bindings: ["http", "graphql"] },
  },
  capabilities: [
    capability({
      id: "aircon.status.get",
      description: "Read the unit's power, mode, fan speed, target temperature and room temperature.",
      audience: everywhere,
      readOnly: true,
      output: Status,
      failures: { Offline },
      run: (_, { context }) => {
        const { online, firmware: _firmware, ...status } = context.unit.state;
        return online ? ok(status) : fail("Offline");
      },
    }),
    capability({
      id: "aircon.power.set",
      description: "Turn the unit on or off.",
      audience: everywhere,
      input: z.object({ on: z.boolean() }),
      failures: { Offline },
      run: ({ on }, { context }) => change(context.unit, { power: on }),
    }),
    capability({
      id: "aircon.mode.set",
      description: "Choose how the unit runs.",
      audience: controls,
      input: z.object({ mode: Mode }),
      failures: { Offline, PoweredOff },
      run: ({ mode }, { context }) =>
        context.unit.state.power ? change(context.unit, { mode }) : fail("PoweredOff"),
    }),
    capability({
      id: "aircon.temperature.set",
      description: "Set the target temperature in degrees Celsius.",
      audience: controls,
      input: z.object({ celsius: z.number().min(16).max(31) }),
      failures: { Offline },
      run: ({ celsius }, { context }) => change(context.unit, { targetCelsius: celsius }),
    }),
    capability({
      id: "aircon.fan.set",
      description: "Set the fan speed.",
      audience: controls,
      input: z.object({ speed: FanSpeed }),
      failures: { Offline },
      run: ({ speed }, { context }) => change(context.unit, { fan: speed }),
    }),
    capability({
      id: "aircon.firmware.update",
      description: "Install the latest firmware. The unit restarts and is offline for about a minute.",
      audience: ["app"],
      failures: { Offline, UpToDate },
      availability: (context) => context.unit.online,
      run: (_, { context }) => fail("UpToDate", { version: context.unit.state.firmware }),
    }),
  ],
});

/** Converts a Zod schema to JSON Schema, for the catalog. */
export const toJsonSchema = (schema: unknown) => z.toJSONSchema(schema as z.ZodType, { target: "draft-2020-12" });
