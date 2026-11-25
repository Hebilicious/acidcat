import type { PageData, Router } from "vaporpress/client";
import { pageOf } from "vaporpress/client";

/** The homepage does not use the layout of the docs, so it is a chunk of its own. */
export const loadDocsLayout = () => import("./DocsLayout.vue");

export const isHomePage = (page: PageData): boolean => page.frontmatter["layout"] === "home";

/** Loads the layout of the docs before a page change to a page that uses it, so the page change shows no empty layout. */
export const loadDocsLayoutBeforePageChange = (router: Router): void => {
  router.beforeResolve(async (to) => {
    if (!isHomePage(pageOf(to))) await loadDocsLayout();
  });
};
