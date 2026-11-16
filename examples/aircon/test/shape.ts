import { readFileSync } from "node:fs";

import { z } from "zod";

const Catalog = z.looseObject({
  targets: z.record(z.string(), z.looseObject({ bindings: z.array(z.string()) })),
  capabilities: z.record(
    z.string(),
    z.looseObject({
      audience: z.array(z.string()).optional(),
      readOnly: z.boolean().optional(),
      failures: z.record(z.string(), z.looseObject({})).optional(),
      state: z.looseObject({}).optional(),
    }),
  ),
  events: z
    .record(
      z.string(),
      z.looseObject({ audience: z.array(z.string()).optional(), input: z.looseObject({}).optional(), payload: z.looseObject({}).optional() }),
    )
    .optional(),
});

export function shape(catalog: unknown) {
  const { targets, capabilities, events = {} } = Catalog.parse(catalog);
  return {
    targets,
    capabilities: Object.fromEntries(
      Object.entries(capabilities).map(([id, capability]) => [
        id,
        {
          audience: capability.audience,
          readOnly: capability.readOnly ?? false,
          failures: Object.keys(capability.failures ?? {}).sort(),
          state: capability.state !== undefined,
        },
      ]),
    ),
    events: Object.fromEntries(
      Object.entries(events).map(([id, event]) => [
        id,
        { audience: event.audience, input: event.input !== undefined, payload: event.payload?.["$ref"] ?? event.payload !== undefined },
      ]),
    ),
  };
}

export const writtenText = readFileSync(new URL("../catalog/aircon.acidcat.json", import.meta.url), "utf-8");
