import { fileURLToPath } from "node:url";
import { defineLoader } from "vaporpress/data";
import type { LoadedData } from "vaporpress/data";
import { docsSidebar, examplesSidebar } from "../lib/docs-sidebar.ts";
import { readSpecPages, specSidebar } from "../lib/spec-pages.ts";
import type { Section } from "../theme/site-theme.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));
const content = fileURLToPath(new URL("../../content", import.meta.url));

const loader = defineLoader({
  watch: [content, fileURLToPath(new URL("../../../spec", import.meta.url))],
  load: async (): Promise<readonly Section[]> => [
    { prefix: "/docs/", title: "Documentation", note: "Guides and concepts", href: "/docs/", items: await docsSidebar(content) },
    { prefix: "/examples/", title: "Examples", note: "Programs that you can run", href: "/examples/", items: await examplesSidebar(content) },
    { prefix: "/spec/", title: "Specification", note: "Version 0.1, draft", href: "/spec/", items: specSidebar(await readSpecPages(repositoryRoot)) },
  ],
});

export default loader;
export declare const data: LoadedData<typeof loader>;
