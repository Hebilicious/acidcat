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
}

/**
 * The calls to `fixture.hold` that hold now, for all the sessions of the provider. `mark` creates the file of a marker:
 * only the command line of the fixture can write files.
 */
export class Holds {
  readonly #holding = new Set<{ readonly key: string; readonly release: () => void }>();
  readonly #mark: (path: string) => Promise<void>;

  constructor(mark: (path: string) => Promise<void> = () => Promise.reject(new Error("This host writes no files."))) {
    this.#mark = mark;
  }

  /**
   * Hold until `release` releases the key, or until the signal aborts. A promise alone does not keep a Node.js process
   * running, so a timer keeps the command line running while the call holds.
   */
  async hold(key: string, marker: string | undefined, signal: AbortSignal): Promise<void> {
    const running = setInterval(() => undefined, 2 ** 30);
    const released = new Promise<void>((resolve) => {
      const entry = { key, release: resolve };
      this.#holding.add(entry);
      signal.addEventListener("abort", () => {
        this.#holding.delete(entry);
        resolve();
      });
    });
    try {
      if (marker !== undefined) await this.#mark(marker);
      await released;
    } finally {
      clearInterval(running);
    }
  }

  held(): string[] {
    return [...this.#holding].map((entry) => entry.key).sort();
  }

  release(key: string): number {
    const released = [...this.#holding].filter((entry) => entry.key === key);
    for (const entry of released) {
      this.#holding.delete(entry);
      entry.release();
    }
    return released.length;
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
const Released = z.object({ released: z.number().int() });
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
        "Hold until fixture.release releases the key, then return the key. While the call holds, fixture.held lists the key. With a marker, the call creates the file at that path when it starts to hold.",
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
      description: "List the keys of the calls to fixture.hold that hold now, in code point order.",
      audience: everywhere,
      readOnly: true,
      output: Keys,
      run: (_, { context }) => ok({ keys: context.holds.held() }),
    }),
    defineCapability<Context, typeof Key, typeof Released>({
      id: "fixture.release",
      description: "Release the calls to fixture.hold that hold the key, and return how many calls it released.",
      audience: everywhere,
      input: Key,
      output: Released,
      run: ({ key }, { context }) => ok({ released: context.holds.release(key) }),
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

/** The options of a session or a binding of the fixture. `mark` creates the file of a marker. */
export const options = (mark?: (path: string) => Promise<void>) => ({
  context: { switch: new Switch(), holds: new Holds(mark) },
  toJsonSchema,
  onDefect: () => undefined,
});
