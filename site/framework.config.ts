import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { defineConfig } from "vite";
import type { Plugin } from "vite";
import { vaporpress } from "vaporpress/vite";
import { writeExampleFragments } from "./src/lib/example-fragments.ts";
import { readFavicon } from "./src/lib/favicon.ts";
import { startScriptsAfterFirstPaint } from "./src/lib/preload-scripts.ts";
import { inlineStyles, markRoutes } from "./src/lib/route-styles.ts";
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
const favicon = await readFavicon();
const outDir = fileURLToPath(new URL(".out/framework", import.meta.url));
const specFiles = new Map(specPages.map((page) => [fileURLToPath(new URL(`../${page.source}`, import.meta.url)), page]));

const specMarkdown = (file: string): string | undefined => {
  const page = specFiles.get(file);
  if (page === undefined) return undefined;
  return ["---", `title: ${JSON.stringify(page.title)}`, `description: ${JSON.stringify(page.description)}`, `source: ${JSON.stringify(page.source)}`, "---", "", page.body].join("\n");
};

const homeComponents = fileURLToPath(new URL("src/components/", import.meta.url));

/** The figures of the homepage serve both builds. In this build, they take the directive of the Vapor components. */
const vaporCodeHtml: Plugin = {
  name: "acidcat:vapor-code-html",
  enforce: "pre",
  resolveId: (source, importer) => (source === "./code-html.ts" && importer?.startsWith(homeComponents) === true ? fileURLToPath(new URL("src/app/code-html.ts", import.meta.url)) : undefined),
};

/** The AcidCat site on vaporpress. VitePress builds the site that is deployed until every part has moved. */
export default defineConfig({
  build: {
    outDir,
    assetsInlineLimit: 0,
    cssCodeSplit: false,
    rollupOptions: { output: { chunkFileNames: "assets/[name].[hash].js", assetFileNames: "assets/[name].[hash].[ext]" } },
  },
  environments: { client: { build: { rollupOptions: { output: { entryFileNames: "assets/[name].[hash].js" } } } } },
  css: { postcss: { plugins: [markRoutes()] } },
  publicDir: "public",
  server: { fs: { allow: [repositoryRoot] } },
  plugins: [
    vaporCodeHtml,
    vaporpress({
    root,
    app: "src/app/app.ts",
    pages: "content",
    exclude: ["index.md", "spec/**", "packages/**"],
    extraPages: () => [
      { path: "/", file: fileURLToPath(new URL("src/app/pages/home.vue", import.meta.url)) },
      { path: "/packages", file: fileURLToPath(new URL("src/app/pages/packages.vue", import.meta.url)) },
      ...specPages.map((page) => ({ path: `/${page.id}`, file: fileURLToPath(new URL(`../${page.source}`, import.meta.url)) })),
    ],
    search: true,
    headHtml: `<meta name="theme-color" content="#0b0e14"><link rel="icon" type="image/svg+xml" href="${favicon.href}">`,
    markdown: {
      transformSource: (source, file) => expandComponents(specMarkdown(file) ?? source, { page: relative(repositoryRoot, file), repositoryRoot, content, roles: true }),
      slugify: headingSlug,
      highlight: highlightBlock,
      hastPlugins: [headingAnchors, externalLinks],
    },
    preload: (page) => (page.frontmatter["layout"] === "home" ? [] : ["src/app/DocsLayout.vue"]),
    transformHtml: async (html, page, { files }) =>
      writeExplorerSources(await startScriptsAfterFirstPaint(html.replace('<link rel="stylesheet"', `${fontPreloadHtml(page.path === "/" ? "home" : "docs", files)}<link rel="stylesheet"`), outDir), repositoryRoot),
    afterBuild: async () => {
      await inlineStyles(outDir);
      await favicon.write(outDir);
      await writeExampleFragments(outDir, repositoryRoot);
    },
  }),
  ],
});
