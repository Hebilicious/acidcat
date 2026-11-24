import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { siteFramework } from "acid-cat-site-framework/vite";

export default defineConfig({
  define: { __VUE_PROD_HYDRATION_MISMATCH_DETAILS__: true },
  plugins: siteFramework({
    root: fileURLToPath(new URL(".", import.meta.url)),
    app: "src/app.ts",
    extraPages: () => [{ path: "/more/outside", file: fileURLToPath(new URL("content/outside.md", import.meta.url)) }],
    headHtml: '<meta name="theme-color" content="#000000">',
    markdown: { highlight: (code, language, meta) => `<pre class="highlighted" data-language="${language}" data-meta="${meta.replaceAll('"', "&quot;")}"><code>${code.replaceAll("&", "&amp;").replaceAll("<", "&lt;")}</code></pre>` },
  }),
});
