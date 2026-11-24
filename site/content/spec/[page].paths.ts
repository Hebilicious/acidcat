import { fileURLToPath } from "node:url";
import { readSpecPages, specRoute } from "../../src/lib/spec-pages.ts";

const repositoryRoot = fileURLToPath(new URL("../../..", import.meta.url));

export default {
  watch: [fileURLToPath(new URL("../../../spec/**/*.md", import.meta.url))],
  paths: async () =>
    (await readSpecPages(repositoryRoot)).map((page) => ({
      params: { page: specRoute(page.id), title: page.title, description: page.description, source: page.source },
      content: page.body,
    })),
};
