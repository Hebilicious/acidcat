/**
 * The air conditioner of `catalog/aircon.pkl`, written with @acid-cat/core-effect. The unit is simulated in memory.
 */
import { AVAILABLE } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Context, Effect, Layer, Ref, Schema, Stream, SubscriptionRef } from "effect";

import { App, Capability, Event } from "@acid-cat/core-effect";

// --- Types -------------------------------------------------------------------------------------------------------

export const Mode = Schema.Literals(["cool", "heat", "dry", "fan", "auto"]).annotate({ identifier: "Mode" });
export const FanSpeed = Schema.Literals(["auto", "low", "medium", "high"]).annotate({ identifier: "FanSpeed" });

/** A target temperature that the unit accepts. */
export const Celsius = Schema.Finite.check(Schema.isBetween({ minimum: 16, maximum: 31 }));

export const Day = Schema.Literals(["mon", "tue", "wed", "thu", "fri", "sat", "sun"]).annotate({ identifier: "Day" });

/** An hour of the day, from 0 to 23. */
const Hour = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 23 }));

export const Schedule = Schema.Struct({ days: Schema.Array(Day), hours: Schema.Array(Hour) }).annotate({ identifier: "Schedule" });

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

/** The simulated unit. Its refs are the state and the availability that the capabilities give to clients. */
export class Unit extends Context.Service<
  Unit,
  {
    readonly status: SubscriptionRef.SubscriptionRef<typeof Status.Type>;
    /** Available while the unit is online, and `unavailable("The unit is offline.")` while it is not. */
    readonly connection: SubscriptionRef.SubscriptionRef<Availability>;
    readonly firmware: string;
    /** The days and hours when the unit turns on. */
    readonly schedule: Ref.Ref<typeof Schedule.Type>;
    /** The number of subscriptions to `aircon.status.changed` that follow the status now. The tests read it. */
    readonly statusListeners: SubscriptionRef.SubscriptionRef<number>;
  }
>()("aircon/Unit") {}

export const unitLayer = Layer.effect(
  Unit,
  Effect.gen(function* () {
    return {
      status: yield* SubscriptionRef.make<typeof Status.Type>({ power: false, mode: "cool", fan: "auto", targetCelsius: 22, roomCelsius: 25 }),
      connection: yield* SubscriptionRef.make<Availability>(AVAILABLE),
      firmware: "1.0.0",
      schedule: yield* Ref.make<typeof Schedule.Type>({ days: [], hours: [] }),
      statusListeners: yield* SubscriptionRef.make(0),
    };
  }),
);

/** The ref of the status of the unit, if the unit is online. */
const onlineStatus = Effect.gen(function* () {
  const unit = yield* Unit;
  if (!(yield* SubscriptionRef.get(unit.connection)).available) return yield* Effect.fail(Offline.make({}));
  return unit.status;
});

/** Change the unit if it is online. */
const change = (update: (status: typeof Status.Type) => typeof Status.Type) =>
  Effect.gen(function* () {
    yield* SubscriptionRef.update(yield* onlineStatus, update);
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
  state: { schema: Status, value: Unit.useSync((unit) => unit.status) },
  run: () => Effect.flatMap(onlineStatus, SubscriptionRef.get),
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
      if (!(yield* SubscriptionRef.get((yield* Unit).status)).power) return yield* Effect.fail(PoweredOff.make({}));
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

export const scheduleSet = Capability.make({
  id: "aircon.schedule.set",
  description: "Turn the unit on at each given hour, on each given day. The default hour is 7.",
  audience: controls,
  input: Schema.Struct({ days: Schema.Array(Day), hours: Schema.optionalKey(Schema.Array(Hour)) }),
  output: Schedule,
  failures: [Offline],
  run: ({ days, hours = [7] }) =>
    Effect.gen(function* () {
      yield* onlineStatus;
      const schedule = { days, hours };
      yield* Ref.set((yield* Unit).schedule, schedule);
      return schedule;
    }),
});

export const firmwareUpdate = Capability.make({
  id: "aircon.firmware.update",
  description: "Install the latest firmware. The unit restarts and is offline for about a minute.",
  audience: ["app"],
  failures: [Offline, UpToDate],
  availability: Unit.useSync((unit) => unit.connection),
  run: () => Effect.flatMap(Unit, (unit) => Effect.fail(UpToDate.make({ version: unit.firmware }))),
});

// --- The events --------------------------------------------------------------------------------------------------

/** True if two statuses are the same. */
const sameStatus = (a: typeof Status.Type, b: typeof Status.Type) => JSON.stringify(a) === JSON.stringify(b);

export const statusChanged = Event.make({
  id: "aircon.status.changed",
  description: "The status of the unit changed. The occurrence gives the new status.",
  audience: everywhere,
  input: Schema.Struct({}),
  payload: Status,
  // The changes of the ref start with the status of now. Each later status that is not the same is an occurrence. The
  // count of listeners goes up when the stream starts, and down when it ends.
  subscribe: () =>
    Stream.unwrap(
      Effect.gen(function* () {
        const unit = yield* Unit;
        yield* Effect.acquireRelease(SubscriptionRef.update(unit.statusListeners, (count) => count + 1), () =>
          SubscriptionRef.update(unit.statusListeners, (count) => count - 1),
        );
        return SubscriptionRef.changes(unit.status);
      }),
    ).pipe(
      Stream.changesWith(sameStatus),
      Stream.drop(1),
      Stream.map((status) => ({ data: status })),
    ),
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
  capabilities: [statusGet, powerSet, modeSet, temperatureSet, fanSet, scheduleSet, firmwareUpdate],
  events: [statusChanged],
});
