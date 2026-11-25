import { fileURLToPath } from "node:url";
import { createHighlighter } from "shiki";
import { defineConfig } from "vite";
import { vaporpress } from "framework/vite";

const highlighter = await createHighlighter({ themes: ["github-light", "github-dark"], langs: ["sh", "json", "ts"] });

// Runs before the first paint, so a page shows the theme that the reader chose, with no flash of the other one.
const themeScript = `<script>try{const t=localStorage.getItem("theme");if(t==="light"||t==="dark")document.documentElement.dataset.theme=t}catch{}</script>`;
const copyButton = '<button type="button" class="copy-code" aria-label="Copy code"><svg aria-hidden="true" viewBox="0 0 24 24"><rect x="9" y="9" width="11" height="11" rx="2" /><path d="M5 15V6a2 2 0 0 1 2-2h9" /></svg></button>';

export default defineConfig({
  plugins: vaporpress({
    root: fileURLToPath(new URL(".", import.meta.url)),
    app: "src/app.ts",
    search: true,
    headHtml: themeScript,
    markdown: {
      highlight: (code, language) =>
        `<div class="code-block">${copyButton}${highlighter.codeToHtml(code.replace(/\n$/, ""), { lang: language === "" ? "text" : language, themes: { light: "github-light", dark: "github-dark" }, defaultColor: false })}</div>`,
    },
  }),
});
