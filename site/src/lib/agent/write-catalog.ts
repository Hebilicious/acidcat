import { writeFile } from "node:fs/promises";
import { renderCatalog } from "@acid-cat/core-ts";
import { site, toJsonSchema } from "./app.ts";

export const catalogPath = new URL("../../../site.acidcat.json", import.meta.url);

if (import.meta.main) await writeFile(catalogPath, renderCatalog(site, { toJsonSchema }));
