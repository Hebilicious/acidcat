import { fileURLToPath } from "node:url";
import { relative } from "node:path";
import { build as esbuild } from "esbuild";
import { defineConfig } from "vite";
import { vaporpress } from "vaporpress/vite";
import { writeAgentFiles } from "./src/lib/agent/files.ts";
import { writeExampleFragments } from "./src/lib/example-fragments.ts";
import { readFavicon } from "./src/lib/favicon.ts";
import { startScriptsAfterFirstPaint } from "./src/lib/preload-scripts.ts";
import { inlineStyles, markRoutes } from "./src/lib/route-styles.ts";
import { fontPreloadHtml } from "./src/lib/fonts.ts";
import { writeExplorerSources } from "./src/lib/example-highlight.ts";
import { expandComponents } from "./src/lib/markdown/components.ts";
import { highlightBlock, headingAnchors, externalLinks } from "./src/app/markdown.ts";
import { headingSlug } from "./src/lib/heading-slug.ts";
import { writeSitemap } from "./src/lib/sitemap.ts";
import { siteUrl } from "./src/lib/social.ts";
import { readSpecPages } from "./src/lib/spec-pages.ts";

const root = fileURLToPath(new URL(".", import.meta.url));
const repositoryRoot = fileURLToPath(new URL("..", import.meta.url));
const content = fileURLToPath(new URL("content", import.meta.url));
const specPages = await readSpecPages(repositoryRoot);
const favicon = await readFavicon();
const outDir = fileURLToPath(new URL("dist", import.meta.url));
const specFiles = new Map(specPages.map((page) => [fileURLToPath(new URL(`../${page.source}`, import.meta.url)), page]));

const tabInput = await esbuild({ entryPoints: [fileURLToPath(new URL("src/app/tab-input.ts", import.meta.url))], bundle: true, minify: true, format: "iife", target: "es2022", write: false });
const tabInputScript = `<script>${tabInput.outputFiles[0]?.text.trim() ?? ""}</script>`;

const searchDialogMeta = (files: readonly string[]): string => {
  const href = files.find((file) => /\/SearchDialog\.[\w-]+\.js$/.test(file));
  if (href === undefined) throw new Error("The build has no chunk for SearchDialog.vue.");
  return `<meta name="acidcat:search-dialog" content="${href}">`;
};

const specMarkdown = (file: string): string | undefined => {
  const page = specFiles.get(file);
  if (page === undefined) return undefined;
  return ["---", `title: ${JSON.stringify(page.title)}`, `description: ${JSON.stringify(page.description)}`, `source: ${JSON.stringify(page.source)}`, "---", "", page.body].join("\n");
};

/** The AcidCat site on vaporpress. */
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
  plugins: vaporpress({
    root,
    app: "src/app/app.ts",
    pages: "content",
    extraPages: () => specPages.map((page) => ({ path: `/${page.id}`, file: fileURLToPath(new URL(`../${page.source}`, import.meta.url)) })),
    search: true,
    headHtml: `<meta name="theme-color" content="#0b0e14"><link rel="icon" type="image/svg+xml" href="${favicon.href}">`,
    markdown: {
      transformSource: (source, file) => expandComponents(specMarkdown(file) ?? source, { page: relative(repositoryRoot, file), repositoryRoot, content }),
      slugify: headingSlug,
      highlight: highlightBlock,
      hastPlugins: [headingAnchors, externalLinks],
    },
    preload: (page) => (page.frontmatter["layout"] === "home" ? [] : ["src/app/DocsLayout.vue"]),
    transformHtml: async (html, page, { files }) => {
      const scriptsFirst = await startScriptsAfterFirstPaint(html, outDir);
      const fonts = fontPreloadHtml(page.path === "/" ? "home" : "docs", files);
      const docsOnly = page.path === "/" ? "" : tabInputScript;
      return writeExplorerSources(scriptsFirst.replace("</head>", `${fonts}${searchDialogMeta(files)}${docsOnly}</head>`), repositoryRoot);
    },
    afterBuild: async () => {
      await inlineStyles(outDir);
      await favicon.write(outDir);
      await writeExampleFragments(outDir, repositoryRoot);
      await writeSitemap(outDir, siteUrl);
      await writeAgentFiles({ dist: outDir, repositoryRoot, origin: siteUrl });
    },
  }),
});
