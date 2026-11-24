import { AVAILABLE, unavailable } from "@acid-cat/spec-ts";
import type { Availability } from "@acid-cat/spec-ts";
import { Context, Effect, Layer, Schema, SubscriptionRef } from "effect";

import * as App from "../src/App.ts";
import * as Capability from "../src/Capability.ts";

export const Level = Schema.Int.check(Schema.isBetween({ minimum: 0, maximum: 100 }));

export const Kelvin = Schema.Int.check(Schema.isBetween({ minimum: 2700, maximum: 6500 }));

export const Scene = Schema.Literals(["reading", "relax", "night"]).annotate({ identifier: "Scene" });

export const Light = Schema.Struct({
  on: Schema.Boolean,
  brightness: Level,
  kelvin: Kelvin,
  scene: Schema.optionalKey(Scene),
}).annotate({ identifier: "Light" });

export const Unreachable = Schema.TaggedStruct("Unreachable", {}).annotate({ identifier: "Unreachable" });
export const Burnt = Schema.TaggedStruct("Burnt", { hours: Schema.Int });

export class Lamp extends Context.Service<
  Lamp,
  {
    readonly light: SubscriptionRef.SubscriptionRef<typeof Light.Type>;
    readonly lit: SubscriptionRef.SubscriptionRef<Availability>;
    readonly burntAfter: number | undefined;
    readonly reachable: SubscriptionRef.SubscriptionRef<boolean>;
  }
>()("lamp/Lamp") {}

export const lit = (on: boolean): Availability => (on ? AVAILABLE : unavailable("The lamp is off."));

export const makeLampLayer = (options: { readonly burntAfter?: number } = {}) =>
  Layer.effect(
    Lamp,
    Effect.gen(function* () {
      return {
        light: yield* SubscriptionRef.make<typeof Light.Type>({ on: false, brightness: 80, kelvin: 3000 }),
        lit: yield* SubscriptionRef.make(lit(false)),
        burntAfter: options.burntAfter,
        reachable: yield* SubscriptionRef.make(true),
      };
    }),
  );

export const lampLayer = makeLampLayer();

const reachableLight = Effect.gen(function* () {
  const lamp = yield* Lamp;
  if (!(yield* SubscriptionRef.get(lamp.reachable))) return yield* Effect.fail(Unreachable.make({}));
  return lamp.light;
});

const change = (update: (light: typeof Light.Type) => typeof Light.Type) =>
  Effect.gen(function* () {
    yield* SubscriptionRef.update(yield* reachableLight, update);
    return null;
  });

const everywhere = ["app", "remote", "cli", "mcp", "api"];
const controls = ["app", "cli", "mcp", "api"];

export const lightGet = Capability.make({
  id: "lamp.light.get",
  description: "Read the power, the brightness, the colour temperature and the scene of the lamp.",
  audience: everywhere,
  readOnly: true,
  output: Light,
  failures: [Unreachable],
  state: { schema: Light, value: Lamp.useSync((lamp) => lamp.light) },
  run: () => Effect.flatMap(reachableLight, SubscriptionRef.get),
});

export const powerSet = Capability.make({
  id: "lamp.power.set",
  description: "Turn the lamp on or off. A burnt bulb does not turn on.",
  audience: everywhere,
  input: Schema.Struct({ on: Schema.Boolean }),
  failures: [Unreachable, Burnt],
  run: ({ on }) =>
    Effect.gen(function* () {
      const lamp = yield* Lamp;
      if (on && lamp.burntAfter !== undefined) return yield* Effect.fail(Burnt.make({ hours: lamp.burntAfter }));
      yield* change((light) => ({ ...light, on }));
      yield* SubscriptionRef.set(lamp.lit, lit(on));
      return null;
    }),
});

export const brightnessSet = Capability.make({
  id: "lamp.brightness.set",
  description: "Set the brightness in percent. Only a lamp that is on can change its brightness.",
  audience: everywhere,
  input: Schema.Struct({ level: Level }),
  failures: [Unreachable],
  availability: Lamp.useSync((lamp) => lamp.lit),
  run: ({ level }) => change((light) => ({ ...light, brightness: level })),
});

export const temperatureSet = Capability.make({
  id: "lamp.temperature.set",
  description: "Set the colour temperature in kelvin.",
  audience: controls,
  input: Schema.Struct({ kelvin: Kelvin }),
  failures: [Unreachable],
  run: ({ kelvin }) => change((light) => ({ ...light, kelvin })),
});

export const sceneSet = Capability.make({
  id: "lamp.scene.set",
  description: "Choose a scene. The lamp keeps the scene while it is off.",
  audience: controls,
  input: Schema.Struct({ scene: Scene }),
  failures: [Unreachable],
  run: ({ scene }) => change((light) => ({ ...light, scene })),
});

export const pair = Capability.make({
  id: "lamp.pair",
  description: "Pair the lamp with the phone.",
  audience: ["app"],
  failures: [Unreachable],
  run: () => Effect.as(reachableLight, null),
});

export const lamp = App.make({
  title: "Bedside lamp",
  description: "Control one smart lamp with a dimmable bulb.",
  targets: {
    app: { description: "The phone app.", surfaces: ["typescript"] },
    remote: { description: "A small remote with a power button and a dimmer.", surfaces: ["typescript"] },
    cli: { surfaces: ["cli"] },
    mcp: { description: "Agents, through an MCP server.", surfaces: ["mcp"] },
    api: { description: "Home-automation systems.", surfaces: ["http"] },
  },
  capabilities: [lightGet, powerSet, brightnessSet, temperatureSet, sceneSet, pair],
});
