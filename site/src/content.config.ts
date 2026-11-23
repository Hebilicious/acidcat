import { docsLoader } from "@astrojs/starlight/loaders";
import { docsSchema } from "@astrojs/starlight/schema";
import { defineCollection } from "astro/content/config";
import type { Loader, LoaderContext } from "astro/loaders";
import { join } from "node:path";
import { readSpecPages, repositoryUrl } from "./lib/spec-pages.ts";

const repositoryRoot = join(process.cwd(), "..");
const docs = docsLoader();

const loadSpec = async (context: LoaderContext): Promise<void> => {
  for (const page of await readSpecPages(repositoryRoot)) {
    const data = await context.parseData({
      id: page.id,
      data: {
        title: page.title,
        description: page.description,
        editUrl: `${repositoryUrl}/edit/main/${page.source}`,
        sidebar: { order: page.order },
      },
    });
    context.store.set({
      id: page.id,
      data,
      body: page.body,
      filePath: `../${page.source}`,
      digest: context.generateDigest(page.body),
      rendered: await context.renderMarkdown(page.body),
    });
  }
};

const docsWithSpec: Loader = {
  name: "acidcat-docs-with-spec",
  load: async (context) => {
    await docs.load(context);
    await loadSpec(context);
    context.watcher?.add(join(repositoryRoot, "spec"));
    context.watcher?.on("change", (path) => {
      if (path.startsWith(join(repositoryRoot, "spec"))) void loadSpec(context);
    });
  },
};

export const collections = {
  docs: defineCollection({ loader: docsWithSpec, schema: docsSchema() }),
};
