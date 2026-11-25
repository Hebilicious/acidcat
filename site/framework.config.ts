import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { defineConfig } from "vite";
import { vaporpress } from "vaporpress/vite";
import { writeExampleFragments } from "./src/lib/example-fragments.ts";
import { fontPreloadHtml } from "./src/lib/fonts.ts";
import { writeExplorerSources } from "./src/lib/example-highlight.ts";
import { expandComponents } from "./src/lib/markdown/components.ts";
import { highlightBlock, headingAnchors, externalLinks } from "./src/app/markdown.ts";
import { headingSlug } from "./src/lib/heading-slug.ts";
import { readSpecPages } from "./src/lib/spec-pages.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const content = fileURLToPath(new URL("content", import.meta.url));
const specPages = await readSpecPages(repositoryRoot);
const specFiles = new Map(specPages.map((page) => [fileURLToPath(new URL(`../${page.source}`, import.meta.url)), page]));

const specMarkdown = (file: string): string | undefined => {
  const page = specFiles.get(file);
  if (page === undefined) return undefined;
  return ["---", `title: ${JSON.stringify(page.title)}`, `description: ${JSON.stringify(page.description)}`, `source: ${JSON.stringify(page.source)}`, "---", "", page.body].join("\n");
};

/** The AcidCat site on vaporpress. VitePress builds the site that is deployed until every part has moved. */
export default defineConfig({
  build: { outDir: ".out/framework", assetsInlineLimit: 0 },
  publicDir: "public",
  server: { fs: { allow: [repositoryRoot] } },
  plugins: vaporpress({
    root,
    app: "src/app/app.ts",
    pages: "content",
    exclude: ["index.md", "spec/**", "packages/**"],
    extraPages: () => specPages.map((page) => ({ path: `/${page.id}`, file: fileURLToPath(new URL(`../${page.source}`, import.meta.url)) })),
    search: true,
    headHtml: '<meta name="theme-color" content="#0b0e14">',
    markdown: {
      transformSource: (source, file) => expandComponents(specMarkdown(file) ?? source, { page: relative(repositoryRoot, file), repositoryRoot, content, roles: true }),
      slugify: headingSlug,
      highlight: highlightBlock,
      hastPlugins: [headingAnchors, externalLinks],
    },
    transformHtml: (html, _page, { files }) => writeExplorerSources(html.replace("<link rel=\"stylesheet\"", `${fontPreloadHtml("docs", files)}<link rel="stylesheet"`), repositoryRoot),
    afterBuild: (outDir) => writeExampleFragments(outDir, repositoryRoot),
  }),
});
