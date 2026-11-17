import { rm, writeFile } from "node:fs/promises";

import type { Marker } from "./fixture.ts";

export const fileMarker: Marker = {
  write: (path) => writeFile(path, ""),
  remove: (path) => rm(path, { force: true }),
};
