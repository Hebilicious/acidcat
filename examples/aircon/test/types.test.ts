import assert from "node:assert/strict";
import { test } from "node:test";

import type { Handles } from "@acid-cat/core-effect";
import { createSession } from "@acid-cat/core-ts";

import type * as Types from "../catalog/aircon.types.ts";
import type * as Effect from "../core-effect/aircon.ts";
import * as Plain from "../core-ts/aircon.ts";

type DeepReadonly<T> = T extends readonly (infer Item)[] ? readonly DeepReadonly<Item>[] : T extends object ? { readonly [Key in keyof T]: DeepReadonly<T[Key]> } : T;

type SameApartFromReadonly<A, B> = [DeepReadonly<A>] extends [DeepReadonly<B>] ? ([DeepReadonly<B>] extends [DeepReadonly<A>] ? true : false) : false;

interface Calls<Input, Value, Failure> {
  execute(input: Input): Promise<{ readonly ok: true; readonly value: Value } | { readonly ok: false; readonly error: Failure }>;
}

type InputOf<H> = H extends Calls<infer Input, unknown, unknown> ? Input : never;
type ValueOf<H> = H extends Calls<never, infer Value, unknown> ? Value : never;
type FailureOf<H> = H extends Calls<never, unknown, infer Failure> ? Failure : never;
type StateOf<H> = H extends { readonly snapshot?: { getSnapshot(): infer State } } ? State : never;

type Agrees<H, Id extends keyof Types.Capabilities> = readonly [
  SameApartFromReadonly<InputOf<H>, Types.Capabilities[Id]["input"]>,
  SameApartFromReadonly<ValueOf<H>, Types.Capabilities[Id]["value"]>,
  SameApartFromReadonly<FailureOf<H>, Types.Capabilities[Id]["failure"]>,
];

type AgreesTakingAnyObjectInput<H, Id extends keyof Types.Capabilities> = readonly [
  Types.Capabilities[Id]["input"] extends InputOf<H> ? true : false,
  SameApartFromReadonly<ValueOf<H>, Types.Capabilities[Id]["value"]>,
  SameApartFromReadonly<FailureOf<H>, Types.Capabilities[Id]["failure"]>,
];

interface Subscriptions<Input, Payload> {
  subscribe(input: Input): Promise<AsyncIterable<{ readonly data: Payload }>>;
}

type EventAgrees<H, Id extends keyof Types.Events> =
  H extends Subscriptions<infer Input, infer Payload> ? [SameApartFromReadonly<Input, Types.Events[Id]["input"]>, SameApartFromReadonly<Payload, Types.Events[Id]["payload"]>] : [false];

const AGREES = [true, true, true] as const;

test("the types of acid-cat types typescript and the types that each TypeScript core infers for the handles are the same", async () => {
  await using session = createSession(Plain.aircon, { target: "app", context: { unit: new Plain.Unit() }, toJsonSchema: Plain.toJsonSchema });
  const handle = {
    statusGet: session.handle(Plain.statusGet),
    powerSet: session.handle(Plain.powerSet),
    modeSet: session.handle(Plain.modeSet),
    temperatureSet: session.handle(Plain.temperatureSet),
    fanSet: session.handle(Plain.fanSet),
    scheduleSet: session.handle(Plain.scheduleSet),
    statusExport: session.handle(Plain.statusExport),
    firmwareUpdate: session.handle(Plain.firmwareUpdate),
    statusChanged: session.eventHandle(Plain.statusChanged),
  };
  const plain = {
    "aircon.status.get": AGREES satisfies Agrees<typeof handle.statusGet, "aircon.status.get">,
    "aircon.status.get state": true satisfies SameApartFromReadonly<StateOf<typeof handle.statusGet>, Types.AirconStatusGetState>,
    "aircon.power.set": AGREES satisfies Agrees<typeof handle.powerSet, "aircon.power.set">,
    "aircon.mode.set": AGREES satisfies Agrees<typeof handle.modeSet, "aircon.mode.set">,
    "aircon.temperature.set": AGREES satisfies Agrees<typeof handle.temperatureSet, "aircon.temperature.set">,
    "aircon.fan.set": AGREES satisfies Agrees<typeof handle.fanSet, "aircon.fan.set">,
    "aircon.schedule.set": AGREES satisfies Agrees<typeof handle.scheduleSet, "aircon.schedule.set">,
    "aircon.status.export": AGREES satisfies Agrees<typeof handle.statusExport, "aircon.status.export">,
    "aircon.firmware.update": AGREES satisfies Agrees<typeof handle.firmwareUpdate, "aircon.firmware.update">,
    "aircon.status.changed": [true, true] satisfies EventAgrees<typeof handle.statusChanged, "aircon.status.changed">,
  };
  const effect = {
    "aircon.status.get": AGREES satisfies AgreesTakingAnyObjectInput<Handles.HandleOf<typeof Effect.statusGet>, "aircon.status.get">,
    "aircon.status.get state": true satisfies SameApartFromReadonly<StateOf<Handles.HandleOf<typeof Effect.statusGet>>, Types.AirconStatusGetState>,
    "aircon.power.set": AGREES satisfies Agrees<Handles.HandleOf<typeof Effect.powerSet>, "aircon.power.set">,
    "aircon.mode.set": AGREES satisfies Agrees<Handles.HandleOf<typeof Effect.modeSet>, "aircon.mode.set">,
    "aircon.temperature.set": AGREES satisfies Agrees<Handles.HandleOf<typeof Effect.temperatureSet>, "aircon.temperature.set">,
    "aircon.fan.set": AGREES satisfies Agrees<Handles.HandleOf<typeof Effect.fanSet>, "aircon.fan.set">,
    "aircon.schedule.set": AGREES satisfies Agrees<Handles.HandleOf<typeof Effect.scheduleSet>, "aircon.schedule.set">,
    "aircon.status.export": AGREES satisfies Agrees<Handles.HandleOf<typeof Effect.statusExport>, "aircon.status.export">,
    "aircon.firmware.update": AGREES satisfies AgreesTakingAnyObjectInput<Handles.HandleOf<typeof Effect.firmwareUpdate>, "aircon.firmware.update">,
    "aircon.status.changed": [true, true] satisfies EventAgrees<Handles.EventHandleOf<typeof Effect.statusChanged>, "aircon.status.changed">,
  };
  assert.deepEqual(Object.keys(plain), Object.keys(effect));
  assert.deepEqual(await handle.powerSet.execute({ on: true } satisfies Types.AirconPowerSetInput), { ok: true, value: null });
});
