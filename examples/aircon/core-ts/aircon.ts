/**
 * The air conditioner of `catalog/aircon.pkl`, written with @acid-cat/core-ts and Zod. The unit is simulated in memory.
 */
import { z } from "zod";

import { AVAILABLE, capabilitiesFor, defineApp, eventsFor, fail, ok, unavailable } from "@acid-cat/core-ts";
import type { Availability, Observable, ToJsonSchema } from "@acid-cat/core-ts";

// --- Types -------------------------------------------------------------------------------------------------------

export const Mode = z.enum(["cool", "heat", "dry", "fan", "auto"]).meta({ id: "Mode" });
export const FanSpeed = z.enum(["auto", "low", "medium", "high"]).meta({ id: "FanSpeed" });
export const Day = z.enum(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]).meta({ id: "Day" });
const Hour = z.number().int().min(0).max(23);
export const Schedule = z.object({ days: z.array(Day), hours: z.array(Hour) }).meta({ id: "Schedule" });
export const Status = z
  .object({ power: z.boolean(), mode: Mode, fan: FanSpeed, targetCelsius: z.number(), roomCelsius: z.number() })
  .meta({ id: "Status" });
export const Offline = z.object({ _tag: z.literal("Offline"), since: z.string().optional() }).meta({ id: "Offline" });
export const PoweredOff = z.object({ _tag: z.literal("PoweredOff") });
const UpToDate = z.object({ _tag: z.literal("UpToDate"), version: z.string() });

// --- The unit ----------------------------------------------------------------------------------------------------

export type State = z.infer<typeof Status> & { online: boolean; firmware: string };

/** The simulated unit. */
export class Unit {
  readonly #statusListeners = new Set<(value: z.infer<typeof Status>) => void>();

  /** The status of the unit, as clients observe it. */
  readonly status: Observable<z.infer<typeof Status>> = {
    getSnapshot: () => {
      const { online: _online, firmware: _firmware, ...status } = this.state;
      return status;
    },
    subscribe: (listener) => {
      this.#statusListeners.add(listener);
      return { unsubscribe: () => this.#statusListeners.delete(listener) };
    },
  };

  state: State = { power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25, online: true, firmware: "1.0.0" };
  /** The days and hours when the unit turns on. */
  schedule: z.infer<typeof Schedule> = { days: [], hours: [] };
  readonly #listeners = new Set<(value: Availability) => void>();

  /** The availability of the operations that need the unit online. */
  readonly online: Observable<Availability> = {
    getSnapshot: () => (this.state.online ? AVAILABLE : unavailable("The unit is offline.")),
    subscribe: (listener) => {
      this.#listeners.add(listener);
      return { unsubscribe: () => this.#listeners.delete(listener) };
    },
  };

  /**
   * Each new status of the unit, from now until the signal aborts or the client returns. A change that keeps the same
   * status gives nothing. The listener is registered when this function returns, before the first read.
   */
  statusChanges(signal: AbortSignal): AsyncIterable<z.infer<typeof Status>> {
    const queue: z.infer<typeof Status>[] = [];
    let last = JSON.stringify(this.status.getSnapshot());
    let wake = () => {};
    let open = true;
    const listener = (status: z.infer<typeof Status>) => {
      const text = JSON.stringify(status);
      if (text === last) return;
      last = text;
      queue.push(status);
      wake();
    };
    const stop = () => {
      open = false;
      this.#statusListeners.delete(listener);
      signal.removeEventListener("abort", stop);
      wake();
    };
    this.#statusListeners.add(listener);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const iterator: AsyncIterator<z.infer<typeof Status>, undefined> = {
      next: async () => {
        for (;;) {
          const status = queue.shift();
          if (status !== undefined) return { done: false, value: status };
          if (!open) return { done: true, value: undefined };
          await new Promise<void>((resolve) => (wake = resolve));
        }
      },
      return: async () => {
        stop();
        return { done: true, value: undefined };
      },
    };
    return { [Symbol.asyncIterator]: () => iterator };
  }

  /** The number of listeners of the status, to see when a subscription stops. */
  get statusListeners(): number {
    return this.#statusListeners.size;
  }

  change(update: Partial<State>) {
    this.state = { ...this.state, ...update };
    this.#listeners.forEach((listener) => listener(this.online.getSnapshot()));
    this.#statusListeners.forEach((listener) => listener(this.status.getSnapshot()));
  }
}

export interface Context {
  readonly unit: Unit;
}

const capability = capabilitiesFor<Context>();
const event = eventsFor<Context>();

/** Change the unit if it is online. */
const change = (unit: Unit, update: Partial<State>) => {
  if (!unit.state.online) return fail({ _tag: "Offline" });
  unit.change(update);
  return ok(null);
};

// --- The capabilities --------------------------------------------------------------------------------------------

const everywhere = ["app", "taskbar", "cli", "mcp", "api"];
const controls = ["app", "cli", "mcp", "api"];

export const statusGet = capability({
  id: "aircon.status.get",
  description: "Read the unit's power, mode, fan speed, target temperature and room temperature.",
  audience: everywhere,
  readOnly: true,
  output: Status,
  failures: { Offline },
  state: { schema: Status, source: (context) => context.unit.status },
  run: (_, { context }) => {
    const { online, firmware: _firmware, ...status } = context.unit.state;
    return online ? ok(status) : fail({ _tag: "Offline" });
  },
});

export const powerSet = capability({
  id: "aircon.power.set",
  description: "Turn the unit on or off.",
  audience: everywhere,
  input: z.object({ on: z.boolean() }),
  failures: { Offline },
  run: ({ on }, { context }) => change(context.unit, { power: on }),
});

export const modeSet = capability({
  id: "aircon.mode.set",
  description: "Choose how the unit runs.",
  audience: controls,
  input: z.object({ mode: Mode }),
  failures: { Offline, PoweredOff },
  run: ({ mode }, { context }) =>
    context.unit.state.power ? change(context.unit, { mode }) : fail({ _tag: "PoweredOff" }),
});

export const temperatureSet = capability({
  id: "aircon.temperature.set",
  description: "Set the target temperature in degrees Celsius.",
  audience: controls,
  input: z.object({ celsius: z.number().min(16).max(31) }),
  failures: { Offline },
  run: ({ celsius }, { context }) => change(context.unit, { targetCelsius: celsius }),
});

export const fanSet = capability({
  id: "aircon.fan.set",
  description: "Set the fan speed.",
  audience: controls,
  input: z.object({ speed: FanSpeed }),
  failures: { Offline },
  run: ({ speed }, { context }) => change(context.unit, { fan: speed }),
});

export const scheduleSet = capability({
  id: "aircon.schedule.set",
  description: "Turn the unit on at each given hour, on each given day. The default hour is 7.",
  audience: controls,
  input: z.object({ days: z.array(Day), hours: z.array(Hour).optional() }),
  output: Schedule,
  failures: { Offline },
  run: ({ days, hours = [7] }, { context }) => {
    if (!context.unit.state.online) return fail({ _tag: "Offline" });
    context.unit.schedule = { days, hours };
    return ok(context.unit.schedule);
  },
});

export const firmwareUpdate = capability({
  id: "aircon.firmware.update",
  description: "Install the latest firmware. The unit restarts and is offline for about a minute.",
  audience: ["app"],
  failures: { Offline, UpToDate },
  availability: (context) => context.unit.online,
  run: (_, { context }) => fail({ _tag: "UpToDate", version: context.unit.state.firmware }),
});

// --- The events --------------------------------------------------------------------------------------------------

export const statusChanged = event({
  id: "aircon.status.changed",
  description: "The status of the unit changed. The occurrence gives the new status.",
  audience: everywhere,
  input: z.object({}),
  payload: Status,
  async *subscribe(_, { context, signal }) {
    // The listener is registered before the first await, so the subscription gets each change after subscribe resolves.
    for await (const status of context.unit.statusChanges(signal)) yield { data: status };
  },
});

// --- The application ---------------------------------------------------------------------------------------------

export const aircon = defineApp<Context>({
  title: "Living-room air conditioner",
  description: "Control and monitor one split-unit air conditioner on the home network.",
  targets: {
    app: { description: "The phone, desktop and web apps that people use.", bindings: ["typescript", "acme:swift", "acme:kotlin"] },
    taskbar: { description: "A desktop taskbar widget showing the status and a power toggle.", bindings: ["typescript"] },
    cli: { bindings: ["cli"] },
    mcp: { description: "Agents, through an MCP server.", bindings: ["mcp"] },
    api: { description: "Home-automation systems and scripts.", bindings: ["http"] },
  },
  capabilities: [statusGet, powerSet, modeSet, temperatureSet, fanSet, scheduleSet, firmwareUpdate],
  events: [statusChanged],
});

/** Converts a Zod schema to JSON Schema, for the catalog. */
export const toJsonSchema: ToJsonSchema = (schema) => {
  if (!(schema instanceof z.ZodType)) throw new Error("The air conditioner has only Zod schemas.");
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
};
