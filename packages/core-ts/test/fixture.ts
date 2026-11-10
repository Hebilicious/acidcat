/** A test application with one capability for each behavior that the tests examine. */
import { z } from "zod";

import { AVAILABLE, capabilitiesFor, defineApp, defineCapability, eventsFor, fail, ok, unavailable } from "../src/index.ts";
import type { Availability, Observable } from "../src/index.ts";

/** A switch that the tests turn on and off, to change the availability of `fixture.toggle`. */
export class Switch implements Observable<Availability> {
  #on = true;
  readonly #listeners = new Set<(value: Availability) => void>();

  set(on: boolean) {
    this.#on = on;
    this.#listeners.forEach((listener) => listener(this.getSnapshot()));
  }

  getSnapshot(): Availability {
    return this.#on ? AVAILABLE : unavailable("The switch is off.");
  }

  subscribe(listener: (value: Availability) => void) {
    this.#listeners.add(listener);
    return { unsubscribe: () => this.#listeners.delete(listener) };
  }

  /** The number of listeners, to test when a session subscribes. */
  get subscribers(): number {
    return this.#listeners.size;
  }
}

/**
 * The calls to `fixture.hold` that hold now, for all the sessions of one provider. `mark` writes the file of a marker. A
 * page cannot write files, so only the command line of the fixture gives it.
 */
export class Holds {
  readonly #holding = new Set<{ readonly key: string; readonly stop: () => void }>();
  readonly #mark: ((path: string) => Promise<void>) | undefined;

  constructor(mark?: (path: string) => Promise<void>) {
    this.#mark = mark;
  }

  /** Hold until `release` releases the key, or until the signal aborts. */
  async hold(key: string, marker: string | undefined, signal: AbortSignal): Promise<void> {
    if (signal.aborted) return;
    const { promise: stopped, resolve } = Promise.withResolvers<void>();
    const entry = {
      key,
      stop: () => {
        this.#holding.delete(entry);
        resolve();
      },
    };
    this.#holding.add(entry);
    signal.addEventListener("abort", entry.stop, { once: true });
    // A promise alone does not keep a Node.js process running. The timer keeps the command line running while the call holds.
    const running = setInterval(() => undefined, 2 ** 30);
    try {
      if (marker !== undefined) await this.#mark?.(marker);
      await stopped;
    } finally {
      clearInterval(running);
      signal.removeEventListener("abort", entry.stop);
    }
  }

  held(): string[] {
    return [...this.#holding].map((entry) => entry.key);
  }

  release(key: string): void {
    for (const entry of this.#holding) if (entry.key === key) entry.stop();
  }
}

/** Holds whose calls ignore cancellation: a call holds until it is released. The tests use them to see conform fail. */
export class HoldsThatIgnoreCancellation extends Holds {
  override hold(key: string, marker: string | undefined): Promise<void> {
    return super.hold(key, marker, new AbortController().signal);
  }
}

/**
 * The subscriptions to `fixture.watch` that are active now, for all the sessions of one provider. `mark` writes the file
 * of a marker, as for `Holds`.
 */
export class Watchers {
  readonly #watching = new Set<{ readonly key: string; readonly push: (value: string) => void }>();
  readonly #mark: ((path: string) => Promise<void>) | undefined;

  constructor(mark?: (path: string) => Promise<void>) {
    this.#mark = mark;
  }

  /**
   * The values that `signal` gives for the key, from now until the signal aborts or the client returns. The watch starts
   * when this function returns, before the first read, so that it gets each value from that time.
   */
  watch(key: string, signal: AbortSignal): AsyncIterable<string> {
    const queue: string[] = [];
    let wake = () => {};
    const entry = {
      key,
      push: (value: string) => {
        queue.push(value);
        wake();
      },
    };
    // A promise alone does not keep a Node.js process running. The timer keeps the command line running while the watch is active.
    const running = setInterval(() => undefined, 2 ** 30);
    const stop = () => {
      this.#watching.delete(entry);
      clearInterval(running);
      signal.removeEventListener("abort", stop);
      wake();
    };
    this.#watching.add(entry);
    signal.addEventListener("abort", stop, { once: true });
    if (signal.aborted) stop();
    const iterator: AsyncIterator<string, undefined> = {
      next: async () => {
        for (;;) {
          if (!this.#watching.has(entry)) return { done: true, value: undefined };
          const value = queue.shift();
          if (value !== undefined) return { done: false, value };
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

  /** Write the file of a marker, if this provider writes markers. */
  async mark(path: string): Promise<void> {
    await this.#mark?.(path);
  }

  watching(): string[] {
    return [...this.#watching].map((entry) => entry.key);
  }

  /** Give the value to each watch of the key. Return the number of these watches. */
  signal(key: string, value: string): number {
    const watches = [...this.#watching].filter((entry) => entry.key === key);
    for (const entry of watches) entry.push(value);
    return watches.length;
  }
}

export interface Context {
  readonly switch: Switch;
  readonly holds: Holds;
  readonly watchers: Watchers;
}

/** The JSON Schema of a Zod schema. The fixtures use only Zod schemas. */
export const toJsonSchema = (schema: unknown) => {
  if (!(schema instanceof z.ZodType)) throw new TypeError("The fixtures give only Zod schemas.");
  return z.toJSONSchema(schema, { target: "draft-2020-12" });
};

/** Read the JSON body of a response, and check it with a schema. */
export const readJson = async <S extends z.ZodType>(response: Response, schema: S): Promise<z.output<S>> => schema.parse(await response.json());

const Text = z.object({ text: z.string() });
const Key = z.object({ key: z.string() });
const Hold = z.object({ key: z.string(), marker: z.string().optional() });
const Keys = z.object({ keys: z.array(z.string()) });
const Tick = z.object({ n: z.number().int() });
const Watched = z.object({ key: z.string(), value: z.string() });
const Flags = z.object({
  mode: z.enum(["fast", "slow"]),
  count: z.number().int().optional(),
  ratio: z.number().optional(),
  label: z.string().optional(),
  verbose: z.boolean().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
  steps: z.array(z.number().int()).optional(),
  tags: z.array(z.string()).optional(),
});

const everywhere = ["app", "mcp", "cli", "api"];
const capability = capabilitiesFor<Context>();
const event = eventsFor<Context>();

/** The position after a cursor of `fixture.ticks`. A cursor that is not a count starts at the first tick. */
const after = (cursor: string | undefined): number => {
  const position = Number(cursor);
  return Number.isInteger(position) && position >= 0 ? position + 1 : 1;
};

export const fixture = defineApp<Context>({
  title: "Fixture",
  description: "One capability or event for each behavior that acid-cat conform tests.",
  targets: {
    app: { bindings: ["typescript", "webmcp"] },
    mcp: { bindings: ["mcp"] },
    cli: { bindings: ["cli"] },
    api: { bindings: ["http"] },
  },
  capabilities: [
    defineCapability({
      id: "fixture.echo",
      description: "Return the input text.",
      audience: everywhere,
      readOnly: true,
      input: Text,
      output: Text,
      run: (input) => ok(input),
    }),
    defineCapability({
      id: "fixture.refuse",
      description: "Always return the failure Refused.",
      audience: everywhere,
      failures: { Refused: z.object({ _tag: z.literal("Refused"), reason: z.string() }) },
      run: () => fail({ _tag: "Refused", reason: "No." }),
    }),
    defineCapability({
      id: "fixture.crash",
      description: "Always fail with a defect.",
      audience: everywhere,
      run: () => {
        throw new Error("secret internal detail");
      },
    }),
    capability({
      id: "fixture.hold",
      description:
        "Hold until fixture.release releases the key, then return the key. While the call holds, fixture.held gives the key. With a marker, the call writes a file at that path when it starts to hold.",
      audience: everywhere,
      input: Hold,
      output: Key,
      run: async ({ key, marker }, { signal, context }) => {
        await context.holds.hold(key, marker, signal);
        return ok({ key });
      },
    }),
    capability({
      id: "fixture.held",
      description: "Return the keys of the calls to fixture.hold that hold now.",
      audience: everywhere,
      readOnly: true,
      output: Keys,
      run: (_, { context }) => ok({ keys: context.holds.held() }),
    }),
    capability({
      id: "fixture.release",
      description: "Release the calls to fixture.hold that hold the key.",
      audience: everywhere,
      input: Key,
      run: ({ key }, { context }) => {
        context.holds.release(key);
        return ok(null);
      },
    }),
    defineCapability({
      id: "fixture.hidden",
      description: "Only the app target can use this capability.",
      audience: ["app"],
      run: () => ok(null),
    }),
    capability({
      id: "fixture.toggle",
      description: "Available only while the switch is on.",
      audience: everywhere,
      input: z.object({}),
      availability: (context) => context.switch,
      run: () => ok(null),
    }),
    capability({
      id: "fixture.switch.set",
      description: "Turn the switch on or off. The switch controls the availability of fixture.toggle.",
      audience: everywhere,
      input: z.object({ on: z.boolean() }),
      run: ({ on }, { context }) => {
        context.switch.set(on);
        return ok(null);
      },
    }),
    defineCapability({
      id: "fixture.flags",
      description: "Return the input. The input has one property for each kind of command-line flag.",
      audience: ["cli"],
      input: Flags,
      output: Flags,
      run: (input) => ok(input),
    }),
    capability({
      id: "fixture.signal",
      description: "Give an occurrence of fixture.watch to each subscription that watches the key. Return the number of these subscriptions.",
      audience: everywhere,
      input: Watched,
      output: z.object({ delivered: z.number().int() }),
      run: ({ key, value }, { context }) => ok({ delivered: context.watchers.signal(key, value) }),
    }),
    capability({
      id: "fixture.watching",
      description: "Return the keys of the subscriptions to fixture.watch that are active now.",
      audience: everywhere,
      readOnly: true,
      output: Keys,
      run: (_, { context }) => ok({ keys: context.watchers.watching() }),
    }),
  ],
  events: [
    event({
      id: "fixture.ticks",
      description: "Give the occurrences n = 1 to count, with the eventId and the cursor String(n), then end. With a cursor c, start at c + 1.",
      audience: everywhere,
      input: z.object({ count: z.number().int().min(0).max(100) }),
      payload: Tick,
      async *subscribe({ count }, { cursor }) {
        for (let n = after(cursor); n <= count; n += 1) yield { data: { n }, eventId: String(n), cursor: String(n) };
      },
    }),
    event({
      id: "fixture.watch",
      description: "Give an occurrence each time that fixture.signal gets the key. Never end. With a marker, write a file at that path when the subscription starts.",
      audience: everywhere,
      input: z.object({ key: z.string(), marker: z.string().optional() }),
      payload: Watched,
      async *subscribe({ key, marker }, { context, signal }) {
        // The watch starts before the first await, so the subscription gets each signal after subscribe resolves.
        const values = context.watchers.watch(key, signal);
        if (marker !== undefined) await context.watchers.mark(marker);
        for await (const value of values) yield { data: { key, value } };
      },
    }),
    event({
      id: "fixture.broken",
      description: "Give the occurrence n = 1, then fail with a defect.",
      audience: everywhere,
      payload: Tick,
      async *subscribe() {
        yield { data: { n: 1 } };
        throw new Error("secret internal detail");
      },
    }),
    event({
      id: "fixture.secret",
      description: "Only the app target can follow this event. It never gives an occurrence.",
      audience: ["app"],
      // An iterator whose next() waits until the subscription ends, and gives no value.
      subscribe: (_, { signal }) => ({
        [Symbol.asyncIterator]: () => ({
          next: () =>
            new Promise<IteratorResult<never, undefined>>((resolve) => {
              const end = () => resolve({ done: true, value: undefined });
              if (signal.aborted) end();
              else signal.addEventListener("abort", end, { once: true });
            }),
        }),
      }),
    }),
  ],
});

/** The options of a session or a binding of the fixture. */
export const options = (holds = new Holds(), watchers = new Watchers()) => ({ context: { switch: new Switch(), holds, watchers }, toJsonSchema, onDefect: () => undefined });

/**
 * An application with one capability, `held.wait`, that runs until its signal aborts. `started` resolves when the call
 * starts, and `seen.aborted` tells if the call saw the abort.
 */
export function heldApp() {
  const started = Promise.withResolvers<void>();
  const seen = { aborted: false };
  const app = defineApp({
    targets: { mcp: { bindings: ["mcp"] }, api: { bindings: ["http"] } },
    capabilities: [
      defineCapability({
        id: "held.wait",
        description: "Wait until the call is cancelled.",
        audience: ["mcp", "api"],
        run: (_input, { signal }) => {
          started.resolve();
          return new Promise((resolve) =>
            signal.addEventListener("abort", () => {
              seen.aborted = true;
              resolve(ok(null));
            }),
          );
        },
      }),
    ],
  });
  return { app, started: started.promise, seen };
}
