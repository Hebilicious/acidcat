/**
 * The parts of a catalog that do not depend on how its schemas are written. The tests of both applications compare
 * these parts of the catalog that the code writes with the parts of `catalog/aircon.acidcat.json`.
 */
import { readFileSync } from "node:fs";

import { z } from "zod";

/** The members of a catalog that `shape` reads. Zod checks them, and keeps the other members. */
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

/**
 * The targets of a catalog, for each capability its audience, its failure tags, and if it is read-only or has state, and
 * for each event its audience, if it has an input, and the type that its payload refers to.
 */
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

/** The text of `catalog/aircon.acidcat.json`, the catalog that `moon run examples` writes from the Pkl source. */
export const writtenText = readFileSync(new URL("../catalog/aircon.acidcat.json", import.meta.url), "utf-8");
