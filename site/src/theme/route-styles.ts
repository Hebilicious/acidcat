import type { Router } from "vitepress";
import { preloadPlate } from "../lib/plate-images.ts";
import { isRoute, routeOfPage, routes } from "../lib/routes.ts";
import type { Route } from "../lib/routes.ts";

const files = (): Partial<Record<Route, string>> => {
  const parsed: unknown = JSON.parse(document.getElementById("route-styles")?.textContent ?? "{}");
  if (typeof parsed !== "object" || parsed === null) return {};
  return Object.fromEntries(Object.entries(parsed).filter((entry): entry is [Route, string] => isRoute(entry[0]) && typeof entry[1] === "string"));
};

const styleElements = (): HTMLElement[] => [...document.head.querySelectorAll<HTMLElement>("style[data-route], link[rel=stylesheet][data-route]")];
const rank = (route: string | undefined): number => routes.findIndex((candidate) => candidate === route);
const loading = new Map<Route, Promise<void>>();
const prefetched = new Set<Route>();

const hasStyles = (route: Route): boolean => loading.has(route) || styleElements().some((element) => element.dataset["route"] === route);

/**
 * Loads the stylesheet of a route that the page does not have yet, in the order of the CSS of the build, and resolves
 * when the browser can use it. The development server gives every page all the CSS, and names no files.
 */
export const loadRouteStyles = (route: Route): Promise<void> => {
  const pending = loading.get(route);
  if (pending !== undefined) return pending;
  const href = files()[route];
  if (href === undefined || hasStyles(route)) return Promise.resolve();
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.href = href;
  link.dataset["route"] = route;
  const loaded = new Promise<void>((resolve) => {
    link.addEventListener("load", () => resolve(), { once: true });
    link.addEventListener("error", () => resolve(), { once: true });
  });
  loading.set(route, loaded);
  document.head.insertBefore(link, styleElements().find((element) => rank(element.dataset["route"]) > rank(route)) ?? null);
  return loaded;
};

export const prefetchRouteStyles = (route: Route): void => {
  const href = files()[route];
  if (href === undefined || prefetched.has(route) || hasStyles(route)) return;
  prefetched.add(route);
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.href = href;
  document.head.append(link);
};

const intent = (event: Event): void => {
  const link = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>("a[href]") : null;
  if (link === null || link.origin !== location.origin || link.target === "_blank") return;
  const route = routeOfPage(link.pathname);
  if (route === routeOfPage(location.pathname)) return;
  prefetchRouteStyles(route);
  if (route === "home") preloadPlate();
};

const prefetchLinkedRoutes = (): void => {
  const current = routeOfPage(location.pathname);
  for (const link of document.querySelectorAll<HTMLAnchorElement>("#app a[href]")) {
    if (link.origin !== location.origin) continue;
    const route = routeOfPage(link.pathname);
    if (route !== current) prefetchRouteStyles(route);
  }
};

/**
 * Loads the stylesheet of the next route while VitePress loads the script of the page, and renders the page when both
 * are there. When the browser is idle after the
 * load, it fetches ahead the stylesheet of each other route that a link of the page leads to, as VitePress does for the
 * scripts of the pages. When the reader points at a link to the homepage, it also preloads the still image of the hero.
 */
export const useRouteStyles = (router: Router): void => {
  let pending: Promise<void> = Promise.resolve();
  router.onBeforePageLoad = (to) => {
    pending = loadRouteStyles(routeOfPage(new URL(to, location.href).pathname));
  };
  router.onAfterPageLoad = () => pending;
  for (const type of ["pointerover", "focusin", "touchstart"]) document.addEventListener(type, intent, { passive: true });
  if (document.readyState === "complete") requestIdleCallback(prefetchLinkedRoutes);
  else addEventListener("load", () => requestIdleCallback(prefetchLinkedRoutes), { once: true });
};
