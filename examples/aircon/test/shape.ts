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
});

/** The targets of a catalog, and for each capability its audience, its failure tags, and if it is read-only or has state. */
export function shape(catalog: unknown) {
  const { targets, capabilities } = Catalog.parse(catalog);
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
  };
}

/** The text of `catalog/aircon.acidcat.json`, the catalog that `moon run examples` writes from the Pkl source. */
export const writtenText = readFileSync(new URL("../catalog/aircon.acidcat.json", import.meta.url), "utf-8");
