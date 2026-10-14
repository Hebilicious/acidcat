/**
 * The air conditioner of examples/aircon.pkl, written with @acid-cat/core-effect. The unit is simulated in memory.
 */
import { AVAILABLE, unavailable } from "@acid-cat/spec-ts";
import { Context, Effect, Layer, Schema, Stream, SubscriptionRef } from "effect";

import { App, Capability } from "../src/index.ts";

// --- Types -------------------------------------------------------------------------------------------------------

export const Mode = Schema.Literals(["cool", "heat", "dry", "fan", "auto"]).annotate({ identifier: "Mode" });
export const FanSpeed = Schema.Literals(["auto", "low", "medium", "high"]).annotate({ identifier: "FanSpeed" });

/** A target temperature that the unit accepts. */
export const Celsius = Schema.Finite.check(Schema.isBetween({ minimum: 16, maximum: 31 }));

export const Status = Schema.Struct({
  power: Schema.Boolean,
  mode: Mode,
  fan: FanSpeed,
  targetCelsius: Schema.Finite,
  roomCelsius: Schema.Finite,
}).annotate({ identifier: "Status" });

export const Offline = Schema.TaggedStruct("Offline", { since: Schema.optional(Schema.String) }).annotate({ identifier: "Offline" });
export const PoweredOff = Schema.TaggedStruct("PoweredOff", {});
const UpToDate = Schema.TaggedStruct("UpToDate", { version: Schema.String });

// --- The unit ----------------------------------------------------------------------------------------------------

type State = typeof Status.Type & { readonly online: boolean; readonly firmware: string };

/** The simulated unit. */
export class Unit extends Context.Service<Unit, SubscriptionRef.SubscriptionRef<State>>()("aircon/Unit") {}

export const unitLayer = Layer.effect(
  Unit,
  SubscriptionRef.make<State>({
    power: false,
    mode: "cool",
    fan: "auto",
    targetCelsius: 22,
    roomCelsius: 25,
    online: true,
    firmware: "1.0.0",
  }),
);

/** Change the unit if it is online. */
const change = (update: (state: State) => State) =>
  Effect.gen(function* () {
    const unit = yield* Unit;
    const state = yield* SubscriptionRef.get(unit);
    if (!state.online) return yield* Effect.fail(Offline.make({}));
    yield* SubscriptionRef.set(unit, update(state));
    return null;
  });

// --- The capabilities --------------------------------------------------------------------------------------------

const everywhere = ["app", "taskbar", "cli", "mcp", "api"];
const controls = ["app", "cli", "mcp", "api"];

export const statusGet = Capability.make({
  id: "aircon.status.get",
  description: "Read the unit's power, mode, fan speed, target temperature and room temperature.",
  audience: everywhere,
  readOnly: true,
  output: Status,
  failures: [Offline],
  state: {
    schema: Status,
    changes: Stream.unwrap(
      Effect.gen(function* () {
        const unit = yield* Unit;
        return SubscriptionRef.changes(unit).pipe(Stream.map(({ online: _, firmware: __, ...status }) => status));
      }),
    ),
  },
  run: () =>
    Effect.gen(function* () {
      const { online, firmware: _, ...status } = yield* SubscriptionRef.get(yield* Unit);
      if (!online) return yield* Effect.fail(Offline.make({}));
      return status;
    }),
});

export const powerSet = Capability.make({
  id: "aircon.power.set",
  description: "Turn the unit on or off.",
  audience: everywhere,
  input: Schema.Struct({ on: Schema.Boolean }),
  failures: [Offline],
  run: ({ on }) => change((state) => ({ ...state, power: on })),
});

export const modeSet = Capability.make({
  id: "aircon.mode.set",
  description: "Choose how the unit runs.",
  audience: controls,
  input: Schema.Struct({ mode: Mode }),
  failures: [Offline, PoweredOff],
  run: ({ mode }) =>
    Effect.gen(function* () {
      if (!(yield* SubscriptionRef.get(yield* Unit)).power) return yield* Effect.fail(PoweredOff.make({}));
      return yield* change((state) => ({ ...state, mode }));
    }),
});

export const temperatureSet = Capability.make({
  id: "aircon.temperature.set",
  description: "Set the target temperature in degrees Celsius.",
  audience: controls,
  input: Schema.Struct({ celsius: Celsius }),
  failures: [Offline],
  run: ({ celsius }) => change((state) => ({ ...state, targetCelsius: celsius })),
});

export const fanSet = Capability.make({
  id: "aircon.fan.set",
  description: "Set the fan speed.",
  audience: controls,
  input: Schema.Struct({ speed: FanSpeed }),
  failures: [Offline],
  run: ({ speed }) => change((state) => ({ ...state, fan: speed })),
});

export const firmwareUpdate = Capability.make({
  id: "aircon.firmware.update",
  description: "Install the latest firmware. The unit restarts and is offline for about a minute.",
  audience: ["app"],
  failures: [Offline, UpToDate],
  availability: Stream.unwrap(
    Effect.gen(function* () {
      const unit = yield* Unit;
      return SubscriptionRef.changes(unit).pipe(
        Stream.map((state) => (state.online ? AVAILABLE : unavailable("The unit is offline."))),
      );
    }),
  ),
  run: () =>
    Effect.gen(function* () {
      const { firmware } = yield* SubscriptionRef.get(yield* Unit);
      return yield* Effect.fail(UpToDate.make({ version: firmware }));
    }),
});

// --- The application ---------------------------------------------------------------------------------------------

export const aircon = App.make({
  title: "Living-room air conditioner",
  description: "Control and monitor one split-unit air conditioner on the home network.",
  targets: {
    app: { description: "The phone, desktop and web apps that people use.", bindings: ["typescript", "acme:swift", "acme:kotlin"] },
    taskbar: { description: "A desktop taskbar widget showing the status and a power toggle.", bindings: ["typescript"] },
    cli: { bindings: ["cli"] },
    mcp: { description: "Agents, through an MCP server.", bindings: ["mcp"] },
    api: { description: "Home-automation systems and scripts.", bindings: ["http"] },
  },
  capabilities: [statusGet, powerSet, modeSet, temperatureSet, fanSet, firmwareUpdate],
});
