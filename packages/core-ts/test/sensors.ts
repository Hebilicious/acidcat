/**
 * Temperature sensors, simulated in memory. The tests use them to examine events: subscriptions, occurrences, the ends of
 * a subscription, slow clients, cursors and each binding.
 */
import { z } from "zod";

import { capabilitiesFor, defineApp, eventsFor, ok } from "../src/index.ts";
import type { Emitted, ToJsonSchema } from "../src/index.ts";

export const Reading = z.object({ room: z.string(), celsius: z.number() }).meta({ id: "Reading" });
export type Reading = z.infer<typeof Reading>;

/** The sensors. Each reading goes to the listeners of that time, and into the history. */
export class Sensors {
  readonly #listeners = new Set<(reading: Emitted<Reading>) => void>();
  readonly history: Emitted<Reading>[] = [];

  /** Send a reading to the listeners. Its cursor is its position in the history. */
  emit(room: string, celsius: number, timestamp = new Date().toISOString()): void {
    const emitted = { data: { room, celsius }, eventId: `reading-${this.history.length}`, timestamp, cursor: String(this.history.length) };
    this.history.push(emitted);
    this.#listeners.forEach((listener) => listener(emitted));
  }

  /** The number of listeners, to test that a subscription stops its work. */
  get listeners(): number {
    return this.#listeners.size;
  }

  /** The readings from now on, until the signal aborts. */
  listen(signal: AbortSignal): AsyncIterable<Emitted<Reading>> {
    return queueOf<Emitted<Reading>>(signal, (push) => {
      this.#listeners.add(push);
      return () => this.#listeners.delete(push);
    });
  }
}

/** An async iterable fed by `subscribe`, which ends when the signal aborts. */
export function queueOf<T>(signal: AbortSignal, subscribe: (push: (value: T) => void) => () => void): AsyncIterable<T> {
  return {
    [Symbol.asyncIterator]() {
      const queue: T[] = [];
      let wake = () => {};
      const unsubscribe = subscribe((value) => {
        queue.push(value);
        wake();
      });
      const onAbort = () => wake();
      signal.addEventListener("abort", onAbort);
      const stop = () => {
        unsubscribe();
        signal.removeEventListener("abort", onAbort);
      };
      if (signal.aborted) stop();
      return {
        async next(): Promise<IteratorResult<T, undefined>> {
          for (;;) {
            if (signal.aborted) {
              stop();
              return { done: true, value: undefined };
            }
            const value = queue.shift();
            if (value !== undefined) return { done: false, value };
            await new Promise<void>((resolve) => (wake = resolve));
          }
        },
        async return(): Promise<IteratorResult<T, undefined>> {
          stop();
          return { done: true, value: undefined };
        },
      };
    },
  };
}

export interface Context {
  readonly sensors: Sensors;
}

const event = eventsFor<Context>();
const capability = capabilitiesFor<Context>();

/** The readings, for all rooms or for one room. */
export const readingChanged = event({
  id: "sensor.reading.changed",
  description: "A sensor gave a new reading. The occurrence gives the room and the temperature.",
  audience: ["app", "api", "cli", "mcp"],
  input: z.object({ room: z.string().optional() }),
  payload: Reading,
  async *subscribe({ room }, { context, signal, cursor, maxAgeMs }) {
    // With a cursor, the readings after that position come first.
    if (cursor !== undefined) {
      const after = Number(cursor);
      const oldest = maxAgeMs === undefined ? 0 : Date.now() - maxAgeMs;
      let skipped = false;
      for (const reading of context.sensors.history.slice(after + 1)) {
        if (Date.parse(reading.timestamp ?? "") < oldest) {
          skipped = true;
          continue;
        }
        if (room === undefined || reading.data.room === room) yield skipped ? { ...reading, truncated: true } : reading;
        skipped = false;
      }
    }
    for await (const reading of context.sensors.listen(signal)) {
      if (room === undefined || reading.data.room === room) yield reading;
    }
  },
});

/** A number of ticks, then the end. No input and no payload. */
export const ticks = event({
  id: "sensor.ticks",
  description: "Three ticks, then the subscription is complete.",
  audience: ["app", "api", "cli", "mcp"],
  async *subscribe() {
    for (let tick = 0; tick < 3; tick += 1) yield { data: {} };
  },
});

/** A tick every 10 milliseconds, until the subscription ends. */
export const clock = event({
  id: "sensor.clock",
  description: "A tick every 10 milliseconds.",
  audience: ["app", "api", "cli", "mcp"],
  async *subscribe(_, { signal }) {
    while (!signal.aborted) {
      yield { data: {} };
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
  },
});

/** One reading, then a reading that does not agree with the payload schema: hotter than 100 °C. */
export const broken = event({
  id: "sensor.broken",
  description: "One good reading, then a reading that is too hot.",
  audience: ["app", "api", "cli", "mcp"],
  payload: z.object({ room: z.string(), celsius: z.number().max(100) }),
  async *subscribe() {
    yield { data: { room: "hall", celsius: 20 } };
    yield { data: { room: "hall", celsius: 500 } };
  },
});

/** One reading, then the provider throws. */
export const failing = event({
  id: "sensor.failing",
  description: "One reading, then the sensor fails.",
  audience: ["app", "api", "cli", "mcp"],
  payload: Reading,
  async *subscribe() {
    yield { data: { room: "hall", celsius: 20 } };
    throw new Error("The secret sensor database is down.");
  },
});

/** An event that only the target `other` sees. */
export const hidden = event({
  id: "sensor.hidden",
  description: "An event for another target.",
  audience: ["other"],
  async *subscribe() {},
});

/** The input is a JSON value with no properties: the CLI takes it as JSON text. */
export const threshold = event({
  id: "sensor.threshold",
  description: "The readings above a temperature.",
  audience: ["app", "api", "cli", "mcp"],
  input: z.union([z.object({ above: z.number() }), z.object({ below: z.number() })]),
  payload: Reading,
  async *subscribe(input, { context, signal }) {
    for await (const reading of context.sensors.listen(signal)) {
      if ("above" in input ? reading.data.celsius > input.above : reading.data.celsius < input.below) yield reading;
    }
  },
});

export const read = capability({
  id: "sensor.read",
  description: "The last reading.",
  audience: ["app", "api", "cli", "mcp"],
  readOnly: true,
  output: Reading.nullable(),
  run: (_, { context }) => ok(context.sensors.history.at(-1)?.data ?? null),
});

export const sensorsApp = defineApp<Context>({
  title: "Sensors",
  description: "Temperature sensors that give readings as events.",
  targets: {
    app: { bindings: ["typescript"] },
    api: { bindings: ["http"] },
    cli: { bindings: ["cli"] },
    mcp: { bindings: ["mcp"] },
    other: { bindings: ["typescript"] },
  },
  capabilities: [read],
  events: [readingChanged, ticks, clock, broken, failing, hidden, threshold],
});

export const toJsonSchema: ToJsonSchema = (schema) => {
  if (!(schema instanceof z.ZodType)) throw new TypeError("The sensors give only Zod schemas.");
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
};

/** The options of a session or a binding, with new sensors. */
export const sensorOptions = (sensors = new Sensors()) => ({ context: { sensors }, toJsonSchema, onDefect: () => undefined });
