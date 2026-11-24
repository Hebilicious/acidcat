import { fileURLToPath } from "node:url";
import { writeFonts } from "../src/lib/fonts.ts";

await writeFonts(fileURLToPath(new URL("../.fonts", import.meta.url)));
