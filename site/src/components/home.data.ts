import { readHomeCode } from "../lib/home-code.ts";
import type { HomeCode } from "../lib/home-code.ts";

export type HomeData = Omit<HomeCode, "code">;

declare const data: HomeData;
export { data };

/** The panels of the homepage figures. Their code comes from the directive `v-code-html`. */
export default {
  watch: ["../../../examples/aircon/catalog/**", "../../../packages/core-*/README.md"],
  load: async (): Promise<HomeData> => {
    const { code: _code, ...panels } = await readHomeCode();
    return panels;
  },
};
