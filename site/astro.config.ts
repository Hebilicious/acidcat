import starlight from "@astrojs/starlight";
import { defineConfig } from "astro/config";
import { fileURLToPath } from "node:url";
import { codeTheme } from "./src/lib/code-theme.ts";
import { specSidebar } from "./src/lib/spec-pages.ts";

const specItems = await specSidebar(fileURLToPath(new URL("..", import.meta.url)));

export default defineConfig({
  site: "https://acidcat.hebilicious.workers.dev",
  integrations: [
    starlight({
      title: "AcidCat",
      description: "Describe what your application can do once. Serve it as a CLI, an MCP server, an HTTP API and typed client code.",
      logo: { src: "./src/assets/mark.svg", alt: "AcidCat" },
      customCss: ["./src/styles/starlight.css"],
      components: {
        Head: "./src/components/starlight/Head.astro",
        Header: "./src/components/starlight/Header.astro",
        PageSidebar: "./src/components/starlight/PageSidebar.astro",
        Sidebar: "./src/components/starlight/Sidebar.astro",
        ThemeSelect: "./src/components/starlight/ThemeSelect.astro",
        ThemeProvider: "./src/components/starlight/ThemeProvider.astro",
      },
      routeMiddleware: "./src/route-middleware.ts",
      editLink: { baseUrl: "https://github.com/Hebilicious/acidcat/edit/main/site/" },
      pagination: true,
      expressiveCode: {
        themes: [codeTheme],
        defaultProps: { wrap: true, preserveIndent: true },
        useStarlightDarkModeSwitch: false,
        useStarlightUiThemeColors: false,
        styleOverrides: {
          borderColor: "color-mix(in oklch, var(--palette-brass-400) 35%, transparent)",
          focusBorder: "var(--palette-brass-400)",
          borderRadius: "var(--radius-size-m)",
          codeFontFamily: "var(--font-family-mono)",
          uiFontFamily: "var(--font-family-label)",
          frames: {
            editorTabBarBackground: "var(--palette-ink-900)",
            editorActiveTabBackground: "var(--palette-ink-950)",
            editorActiveTabIndicatorTopColor: "var(--palette-acid-400)",
            terminalTitlebarBackground: "var(--palette-ink-900)",
            frameBoxShadowCssValue: "none",
          },
        },
      },
      sidebar: [
        {
          label: "Docs",
          items: [
            "docs",
            "docs/quick-start",
            { label: "Concepts", items: [{ autogenerate: { directory: "docs/concepts" } }] },
            { label: "Guides", items: [{ autogenerate: { directory: "docs/guides" } }] },
            { label: "Reference", items: [{ autogenerate: { directory: "docs/reference" } }] },
          ],
        },
        { label: "Specification", items: specItems },
      ],
    }),
  ],
});
