import { rm, writeFile } from "node:fs/promises";

import { Effect } from "effect";

import type { Marker } from "./fixture.ts";

export const fileMarker: Marker = {
  write: (path) => Effect.promise(() => writeFile(path, "")),
  remove: (path) => Effect.promise(() => rm(path, { force: true })),
};
