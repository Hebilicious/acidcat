// Written by `acid-cat types typescript`. Do not change this file by hand.

export type Day = "mon" | "tue" | "wed" | "thu" | "fri" | "sat" | "sun";

export type FanSpeed = "auto" | "low" | "medium" | "high";

export type Mode = "cool" | "heat" | "dry" | "fan" | "auto";

export type Offline = { readonly since?: string; readonly [key: string]: unknown };

export type Schedule = { readonly days: readonly Day[]; readonly hours: readonly number[] };

export type Status = {
  readonly fan: FanSpeed;
  readonly mode: Mode;
  readonly power: boolean;
  readonly roomCelsius: number;
  readonly targetCelsius: number;
};

export type AirconFanSetInput = { readonly speed: FanSpeed };

export type AirconFanSetValue = null;

export type AirconFanSetFailure = { readonly _tag: "Offline" } & Offline;

export type AirconFirmwareUpdateInput = { readonly [key: string]: never };

export type AirconFirmwareUpdateValue = null;

export type AirconFirmwareUpdateFailure =
  | ({ readonly _tag: "Offline" } & Offline)
  | { readonly _tag: "UpToDate"; readonly version: string };

export type AirconModeSetInput = { readonly mode: Mode };

export type AirconModeSetValue = null;

export type AirconModeSetFailure =
  | ({ readonly _tag: "Offline" } & Offline)
  /** The unit must be on before its mode can change. */
  | { readonly _tag: "PoweredOff" };

export type AirconPowerSetInput = { readonly on: boolean };

export type AirconPowerSetValue = null;

export type AirconPowerSetFailure = { readonly _tag: "Offline" } & Offline;

export type AirconScheduleSetInput = { readonly days: readonly Day[]; readonly hours?: readonly number[] };

export type AirconScheduleSetValue = Schedule;

export type AirconScheduleSetFailure = { readonly _tag: "Offline" } & Offline;

export type AirconStatusExportInput = { readonly path: string };

export type AirconStatusExportValue = null;

export type AirconStatusExportFailure =
  | ({ readonly _tag: "Offline" } & Offline)
  | { readonly _tag: "WriteFailed" };

export type AirconStatusGetInput = { readonly [key: string]: never };

export type AirconStatusGetValue = Status;

export type AirconStatusGetFailure = { readonly _tag: "Offline" } & Offline;

export type AirconStatusGetState = Status;

export type AirconTemperatureSetInput = { readonly celsius: number };

export type AirconTemperatureSetValue = null;

export type AirconTemperatureSetFailure = { readonly _tag: "Offline" } & Offline;

export type AirconStatusChangedInput = { readonly [key: string]: never };

export type AirconStatusChangedPayload = Status;

export interface Capabilities {
  /** Set the fan speed. */
  readonly "aircon.fan.set": {
    readonly input: AirconFanSetInput;
    readonly value: AirconFanSetValue;
    readonly failure: AirconFanSetFailure;
  };
  /** Install the latest firmware. The unit restarts and is offline for about a minute. */
  readonly "aircon.firmware.update": {
    readonly input: AirconFirmwareUpdateInput;
    readonly value: AirconFirmwareUpdateValue;
    readonly failure: AirconFirmwareUpdateFailure;
  };
  /** Choose how the unit runs. */
  readonly "aircon.mode.set": {
    readonly input: AirconModeSetInput;
    readonly value: AirconModeSetValue;
    readonly failure: AirconModeSetFailure;
  };
  /** Turn the unit on or off. */
  readonly "aircon.power.set": {
    readonly input: AirconPowerSetInput;
    readonly value: AirconPowerSetValue;
    readonly failure: AirconPowerSetFailure;
  };
  /** Turn the unit on at each given hour, on each given day. The default hour is 7. */
  readonly "aircon.schedule.set": {
    readonly input: AirconScheduleSetInput;
    readonly value: AirconScheduleSetValue;
    readonly failure: AirconScheduleSetFailure;
  };
  /** Write the status to a JSON file. A cancelled call can still write the file. */
  readonly "aircon.status.export": {
    readonly input: AirconStatusExportInput;
    readonly value: AirconStatusExportValue;
    readonly failure: AirconStatusExportFailure;
  };
  /** Read the unit's power, mode, fan speed, target temperature and room temperature. */
  readonly "aircon.status.get": {
    readonly input: AirconStatusGetInput;
    readonly value: AirconStatusGetValue;
    readonly failure: AirconStatusGetFailure;
    readonly state: AirconStatusGetState;
  };
  /** Set the target temperature in degrees Celsius. */
  readonly "aircon.temperature.set": {
    readonly input: AirconTemperatureSetInput;
    readonly value: AirconTemperatureSetValue;
    readonly failure: AirconTemperatureSetFailure;
  };
}

export interface Events {
  /** The status of the unit changed. */
  readonly "aircon.status.changed": {
    readonly input: AirconStatusChangedInput;
    readonly payload: AirconStatusChangedPayload;
  };
}
