import { defineLoader } from "vaporpress/data";
import type { LoadedData } from "vaporpress/data";

const loader = defineLoader({ load: () => ({ numbers: [1, 2, 3], built: "at build time" }) });

export default loader;
export declare const data: LoadedData<typeof loader>;
