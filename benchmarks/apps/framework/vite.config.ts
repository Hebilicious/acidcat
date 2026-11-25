import { fileURLToPath } from "node:url";
import { createHighlighter } from "shiki";
import { defineConfig } from "vite";
import { vaporpress } from "framework/vite";

const highlighter = await createHighlighter({ themes: ["github-light", "github-dark"], langs: ["sh", "json", "ts"] });

export default defineConfig({
  plugins: vaporpress({
    root: fileURLToPath(new URL(".", import.meta.url)),
    app: "src/app.ts",
    markdown: {
      highlight: (code, language) => highlighter.codeToHtml(code.replace(/\n$/, ""), { lang: language === "" ? "text" : language, themes: { light: "github-light", dark: "github-dark" } }),
    },
  }),
});
