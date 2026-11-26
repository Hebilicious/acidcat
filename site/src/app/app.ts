import { defineSite } from "vaporpress/client";
import "virtual:cssforge.css";
import "../styles/site.css";
import { pageHead } from "./head.ts";
import Layout from "./Layout.vue";
import { useRouteStyles } from "./route-styles.ts";

export default defineSite({
  layout: Layout,
  title: (page) => (page.title === "" ? "AcidCat" : page.frontmatter["titleTemplate"] === false ? page.title : `${page.title} | AcidCat`),
  head: pageHead,
  enhance: ({ router }) => {
    if (import.meta.env.SSR) return;
    useRouteStyles(router);
    if ("modelContext" in document || "modelContext" in navigator) void import("../lib/agent/page.ts");
  },
});
