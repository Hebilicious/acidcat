import { computed } from "vue";
import type { ComputedRef } from "vue";
import { createRouter, useRoute } from "vue-router";
import type { RouteLocationNormalizedLoaded, RouteRecordRaw, Router, RouterHistory, RouterScrollBehavior } from "vue-router";
import type { Heading, PageData } from "../page.ts";
import { loadLazyLayouts } from "./lazy-layout.ts";
import type { SiteDefinition } from "./site.ts";

export const notFoundRoute = "vaporpress:not-found";

const defaultScroll: RouterScrollBehavior = (to, from, savedPosition) => {
  if (to.path === from.path && to.hash === from.hash) return false;
  if (savedPosition !== null) return savedPosition;
  if (to.hash !== "") return { el: decodeURIComponent(to.hash), top: 0 };
  return { top: 0 };
};

const findNotFound = (routes: readonly RouteRecordRaw[]): RouteRecordRaw | undefined => routes.find((route) => route.path === "/404");

export const createSiteRouter = (site: SiteDefinition, history: RouterHistory, routes: readonly RouteRecordRaw[]): Router => {
  const component = findNotFound(routes)?.component;
  const fallback: RouteRecordRaw[] = component === undefined || component === null ? [] : [{ path: "/:path(.*)*", name: notFoundRoute, component }];
  const router = createRouter({ history, routes: [...routes, ...fallback], scrollBehavior: site.scrollBehavior ?? defaultScroll });
  router.beforeResolve((to) => loadLazyLayouts(pageOf(to)));
  return router;
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null;

const isHeading = (value: unknown): value is Heading =>
  isRecord(value) && typeof value["level"] === "number" && typeof value["slug"] === "string" && typeof value["title"] === "string";

const isPageFields = (value: unknown): value is Omit<PageData, "path"> =>
  isRecord(value) &&
  typeof value["title"] === "string" &&
  (value["description"] === undefined || typeof value["description"] === "string") &&
  isRecord(value["frontmatter"]) &&
  Array.isArray(value["headings"]) &&
  value["headings"].every((heading) => isHeading(heading));

/** The data of the page of a resolved route. A component that is not a Markdown page can give its own with `defineOptions({ __page: { … } })`. */
export const pageOf = (route: RouteLocationNormalizedLoaded): PageData => {
  const component: unknown = route.matched.at(-1)?.components?.["default"];
  const fields: unknown = isRecord(component) ? component["__page"] : undefined;
  if (isPageFields(fields)) return { ...fields, path: route.path };
  return { path: route.path, title: "", frontmatter: {}, headings: [] };
};

export const usePage = (): ComputedRef<PageData> => {
  const route = useRoute();
  return computed(() => pageOf(route));
};
