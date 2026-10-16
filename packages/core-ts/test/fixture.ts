/** A test application with one capability for each behavior that the tests examine. */
import { z } from "zod";

import { AVAILABLE, defineApp, defineCapability, fail, ok, unavailable } from "../src/index.ts";
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

export interface Context {
  readonly switch: Switch;
  readonly holds: Holds;
}

export const toJsonSchema = (schema: unknown) => z.toJSONSchema(schema as z.ZodType, { target: "draft-2020-12" });

const Text = z.object({ text: z.string() });
const Key = z.object({ key: z.string() });
const Hold = z.object({ key: z.string(), marker: z.string().optional() });
const Keys = z.object({ keys: z.array(z.string()) });
const Flags = z.object({
  mode: z.enum(["fast", "slow"]),
  count: z.number().int().optional(),
  ratio: z.number().optional(),
  label: z.string().optional(),
  verbose: z.boolean().optional(),
  extra: z.record(z.string(), z.unknown()).optional(),
});

const everywhere = ["app", "mcp", "cli", "api"];

export const fixture = defineApp<Context>({
  title: "Fixture",
  description: "One capability for each behavior that acid-cat conform tests.",
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
      run: () => fail("Refused", { reason: "No." }),
    }),
    defineCapability({
      id: "fixture.crash",
      description: "Always fail with a defect.",
      audience: everywhere,
      run: () => {
        throw new Error("secret internal detail");
      },
    }),
    defineCapability<Context, typeof Hold, typeof Key>({
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
    defineCapability<Context, undefined, typeof Keys>({
      id: "fixture.held",
      description: "Return the keys of the calls to fixture.hold that hold now.",
      audience: everywhere,
      readOnly: true,
      output: Keys,
      run: (_, { context }) => ok({ keys: context.holds.held() }),
    }),
    defineCapability<Context, typeof Key>({
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
    defineCapability<Context, z.ZodObject<{}>>({
      id: "fixture.toggle",
      description: "Available only while the switch is on.",
      audience: everywhere,
      input: z.object({}),
      availability: (context) => context.switch,
      run: () => ok(null),
    }),
    defineCapability<Context, z.ZodObject<{ on: z.ZodBoolean }>>({
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
  ],
});

/** The options of a session or a binding of the fixture. */
export const options = (holds = new Holds()) => ({ context: { switch: new Switch(), holds }, toJsonSchema, onDefect: () => undefined });

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
