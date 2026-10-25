/**
 * An electric kettle, simulated in memory. The tests use it to examine typed handles, state, availability, named types
 * and the catalog that the core writes.
 */
import { z } from "zod";

import { AVAILABLE, capabilitiesFor, defineApp, fail, ok, unavailable } from "../src/index.ts";
import type { Availability, Observable, ToJsonSchema } from "../src/index.ts";

// --- Types -------------------------------------------------------------------------------------------------------

/** The drinks that the kettle can keep the water warm for. Each one has its own temperature. */
export const Drink = z.enum(["green-tea", "white-tea", "coffee", "baby-milk"]).meta({ id: "Drink" });
export const KettleStatus = z
  .object({ litres: z.number(), celsius: z.number(), keepWarm: Drink.optional() })
  .meta({ id: "KettleStatus" });
export const Empty = z.object({ _tag: z.literal("Empty") }).meta({ id: "Empty" });
const Overflow = z.object({ _tag: z.literal("Overflow"), capacity: z.number() });
const Boiled = z.object({ celsius: z.number() });

export type Status = z.infer<typeof KettleStatus>;

const CAPACITY = 1.7;
const WARM_CELSIUS: Record<z.infer<typeof Drink>, number> = { "green-tea": 80, "white-tea": 85, coffee: 95, "baby-milk": 40 };

// --- The kettle --------------------------------------------------------------------------------------------------

/** The simulated kettle. Its status is an observable. Each change calls the listeners. */
export class Kettle {
  #status: Status = { litres: 0, celsius: 20 };
  readonly #statusListeners = new Set<(value: Status) => void>();
  readonly #coolListeners = new Set<(value: Availability) => void>();

  /** The status of the kettle. The getter gives the object of the kettle itself, not a copy. */
  get status(): Status {
    return this.#status;
  }

  /** The status, as clients observe it. */
  readonly observed: Observable<Status> = {
    getSnapshot: () => this.#status,
    subscribe: (listener) => {
      this.#statusListeners.add(listener);
      return { unsubscribe: () => this.#statusListeners.delete(listener) };
    },
  };

  /** Available while the water is cooler than 40 °C. */
  readonly cool: Observable<Availability> = {
    getSnapshot: () => (this.#status.celsius < 40 ? AVAILABLE : unavailable("The water is too hot.")),
    subscribe: (listener) => {
      this.#coolListeners.add(listener);
      return { unsubscribe: () => this.#coolListeners.delete(listener) };
    },
  };

  /** The number of listeners of the status, to test when a handle subscribes. */
  get statusListeners(): number {
    return this.#statusListeners.size;
  }

  change(update: Partial<Status>) {
    this.#status = { ...this.#status, ...update };
    this.#statusListeners.forEach((listener) => listener(this.#status));
    this.#coolListeners.forEach((listener) => listener(this.cool.getSnapshot()));
  }
}

export interface Context {
  readonly kettle: Kettle;
}

const capability = capabilitiesFor<Context>();

// --- The capabilities --------------------------------------------------------------------------------------------

export const statusGet = capability({
  id: "kettle.status.get",
  description: "Read the water level, the water temperature, and the drink that the kettle keeps the water warm for.",
  audience: ["app", "panel", "cli", "mcp"],
  readOnly: true,
  output: KettleStatus,
  state: { schema: KettleStatus, source: (context) => context.kettle.observed },
  run: (_, { context }) => ok(context.kettle.status),
});

export const fill = capability({
  id: "kettle.fill",
  description: "Add water, in litres.",
  audience: ["app", "cli", "mcp"],
  input: z.object({ litres: z.number().min(0.1).max(CAPACITY) }),
  failures: { Overflow },
  run: ({ litres }, { context }) => {
    const total = context.kettle.status.litres + litres;
    if (total > CAPACITY) return fail({ _tag: "Overflow", capacity: CAPACITY });
    context.kettle.change({ litres: total });
    return ok(null);
  },
});

export const boil = capability({
  id: "kettle.boil",
  description: "Boil the water, and give its temperature.",
  audience: ["app", "panel", "cli", "mcp"],
  output: Boiled,
  failures: { Empty },
  run: (_, { context }) => {
    if (context.kettle.status.litres === 0) return fail({ _tag: "Empty" });
    context.kettle.change({ celsius: 100 });
    return ok({ celsius: 100 });
  },
});

export const warmSet = capability({
  id: "kettle.warm.set",
  description: "Keep the water warm at the temperature of a drink.",
  audience: ["app", "cli", "mcp"],
  input: z.object({ drink: Drink }),
  failures: { Empty },
  run: ({ drink }, { context }) => {
    if (context.kettle.status.litres === 0) return fail({ _tag: "Empty" });
    context.kettle.change({ keepWarm: drink, celsius: WARM_CELSIUS[drink] });
    return ok(null);
  },
});

export const descale = capability({
  id: "kettle.descale",
  description: "Remove the limescale. The water must be cool.",
  audience: ["app"],
  availability: (context) => context.kettle.cool,
  run: () => ok(null),
});

// --- The application ---------------------------------------------------------------------------------------------

export const kettle = defineApp<Context>({
  title: "Electric kettle",
  description: "Boil water, and keep it warm for a drink.",
  targets: {
    app: { description: "The phone app of the kettle.", bindings: ["typescript"] },
    panel: { description: "The buttons and the display on the base of the kettle.", bindings: ["typescript"] },
    cli: { bindings: ["cli"] },
    mcp: { description: "Agents, through an MCP server.", bindings: ["mcp"] },
  },
  capabilities: [statusGet, fill, boil, warmSet, descale],
});

/** Converts a Zod schema to JSON Schema, for the catalog. */
export const toJsonSchema: ToJsonSchema = (schema) => {
  if (!(schema instanceof z.ZodType)) throw new Error("The kettle has only Zod schemas.");
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
};
