import { fileURLToPath } from "node:url";
import { defineConfig } from "vitepress";
import type { HeadConfig } from "vitepress";
import { writeAgentFiles } from "../src/lib/agent/files.ts";
import { codeTheme } from "../src/lib/code-theme.ts";
import { docsSidebar } from "../src/lib/docs-sidebar.ts";
import { fontPreloads, writeFonts } from "../src/lib/fonts.ts";
import { headingAnchor, headingSlug } from "../src/lib/heading-slug.ts";
import { markdownSetup, searchRender } from "../src/lib/markdown/setup.ts";
import { applyRouteParams, pageHead } from "../src/lib/page-head.ts";
import { writeExampleFragments } from "../src/lib/example-fragments.ts";
import { inlineStyles } from "../src/lib/inline-styles.ts";
import { packageHeaders } from "../src/lib/package-groups.ts";
import { readPublishedPackages } from "../src/lib/packages.ts";
import { writeSitemap } from "../src/lib/sitemap.ts";
import { readSpecPages, specSidebar } from "../src/lib/spec-pages.ts";
import { siteUrl } from "../src/lib/social.ts";
import type { SiteTheme } from "../src/theme/site-theme.ts";

const repositoryRoot = fileURLToPath(new URL("../..", import.meta.url));
const content = fileURLToPath(new URL("../content", import.meta.url));

await writeFonts(fileURLToPath(new URL("../.fonts", import.meta.url)));
const specPages = await readSpecPages(repositoryRoot);
const packages = await readPublishedPackages(repositoryRoot);

const themeConfig: SiteTheme = {
  editBase: "https://github.com/Hebilicious/acidcat/edit/main/",
  sections: [
    { prefix: "/docs/", title: "Documentation", note: "Guides and concepts", href: "/docs/", items: await docsSidebar(content) },
    { prefix: "/spec/", title: "Specification", note: "Version 0.1, draft", href: "/spec/", items: specSidebar(specPages) },
  ],
  search: { provider: "local", options: { _render: searchRender(repositoryRoot, specPages) } },
};

export default defineConfig<SiteTheme>({
  title: "AcidCat",
  titleTemplate: ":title | AcidCat",
  description: "Describe what your application can do once. Serve it as a CLI, an MCP server, an HTTP API and typed client code.",
  lang: "en",
  srcDir: "content",
  outDir: "dist",
  cleanUrls: true,
  appearance: false,
  rewrites: (page) => (page === "index.md" || page === "404.md" || page.endsWith("/index.md") ? page : page.replace(/\.md$/, "/index.md")),
  head: [["meta", { name: "theme-color", content: "#0b0e14" }]],
  themeConfig,
  markdown: {
    theme: codeTheme,
    preWrapper: false,
    externalLinks: { target: "_blank", rel: "noopener noreferrer" },
    anchor: { slugify: headingSlug, permalink: headingAnchor },
    headers: { level: [2, 3], slugify: headingSlug },
    config: (md) => markdownSetup(md, repositoryRoot),
  },
  vite: {
    publicDir: "../public",
    build: { cssCodeSplit: false, assetsInlineLimit: 0 },
    server: { fs: { allow: [repositoryRoot] } },
  },
  transformPageData(pageData) {
    applyRouteParams(pageData);
    if (pageData.relativePath === "packages/index.md") pageData.headers = packageHeaders(packages);
    pageData.frontmatter["head"] = pageHead(pageData, siteUrl);
  },
  transformHead: ({ pageData, assets }): HeadConfig[] => fontPreloads(pageData.relativePath === "index.md" ? "home" : "docs", assets),
  buildEnd: async (config) => {
    await inlineStyles(config.outDir);
    await writeExampleFragments(config.outDir, repositoryRoot);
    await writeSitemap(config.outDir, siteUrl);
    await writeAgentFiles({ dist: config.outDir, repositoryRoot, origin: siteUrl });
  },
});
