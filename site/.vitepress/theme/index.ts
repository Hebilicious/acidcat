import type { Theme } from "vitepress";
import "../../src/styles/site.css";
import { copyCodeOnClick } from "../../src/theme/copy-code.ts";
import Layout from "../../src/theme/Layout.vue";

export default {
  Layout,
  enhanceApp: () => {
    if (import.meta.env.SSR) return;
    copyCodeOnClick();
    if ("modelContext" in document || "modelContext" in navigator) void import("../../src/lib/agent/page.ts");
  },
} satisfies Theme;
