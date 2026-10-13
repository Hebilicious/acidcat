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

export interface Context {
  readonly switch: Switch;
}

export const toJsonSchema = (schema: unknown) => z.toJSONSchema(schema as z.ZodType, { target: "draft-2020-12" });

const Text = z.object({ text: z.string() });
const everywhere = ["app", "mcp", "cli", "api"];

export const fixture = defineApp<Context>({
  title: "Fixture",
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
    defineCapability({
      id: "fixture.slow",
      description: "Wait for some milliseconds, then return null.",
      audience: everywhere,
      input: z.object({ milliseconds: z.number() }),
      run: async ({ milliseconds }, { signal }) => {
        await new Promise((resolve) => {
          const timer = setTimeout(resolve, milliseconds);
          signal.addEventListener("abort", () => clearTimeout(timer));
        });
        return ok(null);
      },
    }),
    defineCapability({
      id: "fixture.hidden",
      description: "Only the app target can use this capability.",
      audience: ["app"],
      run: () => ok(null),
    }),
    defineCapability<Context>({
      id: "fixture.toggle",
      description: "Available only while the switch is on.",
      audience: everywhere,
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
  ],
});

export const options = () => ({ context: { switch: new Switch() }, toJsonSchema, onDefect: () => undefined });
