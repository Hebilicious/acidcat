import { highlight } from "../lib/highlight.ts";
import { readHomeCode } from "../lib/home-code.ts";

declare const data: Readonly<Record<string, string>>;
export { data };

/** The highlighted code of each panel of the homepage, by its name. */
export default {
  watch: ["../../../examples/aircon/catalog/**", "../../../packages/core-*/README.md"],
  load: async (): Promise<Record<string, string>> => Object.fromEntries((await readHomeCode()).code.map((panel) => [panel.slot, highlight(panel.code, panel.language)])),
};
