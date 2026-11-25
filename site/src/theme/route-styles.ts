import type { Router } from "vitepress";
import { cssFont, routeFaces } from "../lib/font-faces.ts";
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
const loading = new Map<Route, Promise<HTMLLinkElement | undefined>>();
const prefetched = new Set<Route>();

const hasStyles = (route: Route): boolean => loading.has(route) || styleElements().some((element) => element.dataset["route"] === route);

/**
 * Fetches the stylesheet of a route that the page does not have yet into its place in the order of the CSS of the
 * build, and resolves with it when it is there. The stylesheet applies to print only, so it does not change the page
 * that the reader still sees. The development server gives every page all the CSS, and names no files.
 */
export const fetchRouteStyles = (route: Route): Promise<HTMLLinkElement | undefined> => {
  const pending = loading.get(route);
  if (pending !== undefined) return pending;
  const href = files()[route];
  if (href === undefined || hasStyles(route)) return Promise.resolve(undefined);
  const link = document.createElement("link");
  link.rel = "stylesheet";
  link.media = "print";
  link.href = href;
  link.dataset["route"] = route;
  const loaded = new Promise<HTMLLinkElement>((resolve) => {
    link.addEventListener("load", () => resolve(link), { once: true });
    link.addEventListener("error", () => resolve(link), { once: true });
  });
  loading.set(route, loaded);
  document.head.insertBefore(link, styleElements().find((element) => rank(element.dataset["route"]) > rank(route)) ?? null);
  return loaded;
};

export const applyRouteStyles = (link: HTMLLinkElement | undefined): void => link?.removeAttribute("media");

/** Loads the stylesheet of a route, and resolves when it applies to the page. */
export const loadRouteStyles = async (route: Route): Promise<void> => applyRouteStyles(await fetchRouteStyles(route));

/** Loads the faces that the first view of a route draws, so that its text does not move when a face arrives. */
export const loadRouteFonts = async (route: Route): Promise<void> => {
  const faces = route === "search" ? [] : routeFaces[route];
  await Promise.all(faces.map((face) => document.fonts.load(cssFont(face)))).catch(() => undefined);
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

const whenIdle = (callback: () => void): void => {
  if ("requestIdleCallback" in window) requestIdleCallback(callback);
  else setTimeout(callback, 0);
};

const prefetchLinkedRoutes = (): void => {
  const current = routeOfPage(location.pathname);
  for (const link of document.querySelectorAll<HTMLAnchorElement>("#app a[href]")) {
    if (link.origin !== location.origin) continue;
    const route = routeOfPage(link.pathname);
    if (route !== current) prefetchRouteStyles(route);
  }
};

/** Fetches ahead the stylesheet of the route of a link under the pointer, and of each link of the page when the browser is idle after the load. */
export const prefetchRoutesAhead = (): void => {
  for (const type of ["pointerover", "focusin", "touchstart"]) document.addEventListener(type, intent, { passive: true });
  if (document.readyState === "complete") whenIdle(prefetchLinkedRoutes);
  else addEventListener("load", () => whenIdle(prefetchLinkedRoutes), { once: true });
};

/**
 * Loads the stylesheet and the faces of the next route while VitePress loads the script of the page, and applies the
 * stylesheet when VitePress renders the page. When the browser is idle after the load, it fetches ahead the stylesheet of each other route
 * that a link of the page leads to, as VitePress does for the scripts of the pages. When the reader points at a link to the homepage, it also preloads the still image of the hero.
 */
export const useRouteStyles = (router: Router): void => {
  let pending: Promise<HTMLLinkElement | undefined> = Promise.resolve(undefined);
  router.onBeforePageLoad = (to) => {
    const route = routeOfPage(new URL(to, location.href).pathname);
    pending = Promise.all([fetchRouteStyles(route), loadRouteFonts(route)]).then(([link]) => link);
  };
  // VitePress renders the new page in the same task as the end of this hook, so no frame shows the old page with the new stylesheet.
  router.onAfterPageLoad = async () => applyRouteStyles(await pending);
  prefetchRoutesAhead();
};
