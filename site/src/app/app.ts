import { defineSite } from "vaporpress/client";
import "../styles/site.css";
import { copyCodeOnClick } from "../theme/copy-code.ts";
import { pageHead } from "./head.ts";
import Layout from "./Layout.vue";
import { useRouteStyles } from "./route-styles.ts";

export default defineSite({
  layout: Layout,
  title: (page) => (page.title === "" ? "AcidCat" : page.frontmatter["titleTemplate"] === false ? page.title : `${page.title} | AcidCat`),
  head: pageHead,
  enhance: ({ router }) => {
    if (import.meta.env.SSR) return;
    copyCodeOnClick();
    useRouteStyles(router);
    if ("modelContext" in document || "modelContext" in navigator) void import("../lib/agent/page.ts");
  },
});
