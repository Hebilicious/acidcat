import { fileURLToPath } from "node:url";
import { readPublishedPackages } from "../lib/packages.ts";
import type { PublishedPackage } from "../lib/packages.ts";

declare const data: readonly PublishedPackage[];
export { data };

/** Every package of the release configuration, with its released version and its description. */
export default {
  watch: ["../../../release-please-config.json", "../../../.release-please-manifest.json", "../../../packages/README.md"],
  load: (): Promise<PublishedPackage[]> => readPublishedPackages(fileURLToPath(new URL("../../..", import.meta.url))),
};
