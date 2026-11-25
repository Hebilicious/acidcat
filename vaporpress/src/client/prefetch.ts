import type { Router } from "vue-router";
import { anchorOf, pageHref } from "./links.ts";
import { pageChunksId } from "./markers.ts";
import { isComponent } from "./site.ts";

type Loader = () => Promise<unknown>;

const isLoader = (value: unknown): value is Loader => typeof value === "function";

const hasDefault = (value: unknown): value is { readonly default: unknown } => typeof value === "object" && value !== null && "default" in value;

/** Loads the chunk of the page that a path leads to, and gives the router the component, so the page change does not wait for the network. */
export const prefetchPage = async (router: Router, path: string): Promise<void> => {
  for (const record of router.resolve(path).matched) {
    const components = record.components;
    const component: unknown = components?.["default"];
    if (components === undefined || components === null || !isLoader(component)) continue;
    const loaded = await component();
    const resolved: unknown = hasDefault(loaded) ? loaded.default : loaded;
    if (isComponent(resolved)) components["default"] = resolved;
  }
};

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

const readPageChunks = (): ReadonlyMap<string, readonly string[]> => {
  const parsed: unknown = JSON.parse(document.getElementById(pageChunksId)?.textContent ?? "{}");
  if (typeof parsed !== "object" || parsed === null) return new Map();
  return new Map(Object.entries(parsed).filter((entry): entry is [string, readonly string[]] => isStringList(entry[1])));
};

const hasFile = (href: string): boolean => [...document.querySelectorAll("link[href], script[src]")].some((element) => element.getAttribute("href") === href || element.getAttribute("src") === href);

const prefetchLink = (href: string): void => {
  if (hasFile(href)) return;
  const link = document.createElement("link");
  link.rel = "prefetch";
  link.crossOrigin = "anonymous";
  link.href = href;
  document.head.append(link);
};

/**
 * Fetches ahead the chunks of the pages of the links in view when the browser is idle, with a prefetch link, so the
 * browser downloads them at a low priority and runs none of them. Loads the page of a link under the pointer or the
 * finger at once.
 */
export const startPrefetch = (router: Router): void => {
  const pageChunks = readPageChunks();
  const fetched = new Set<string>();
  const loaded = new Set<string>();
  const pathOf = (anchor: HTMLAnchorElement): string | undefined => {
    const href = pageHref(router, anchor);
    const path = href === undefined ? undefined : new URL(href, location.href).pathname;
    return path === location.pathname ? undefined : path;
  };
  const fetchAhead = (anchor: HTMLAnchorElement): void => {
    const path = pathOf(anchor);
    if (path === undefined || fetched.has(path) || loaded.has(path)) return;
    fetched.add(path);
    const chunks = pageChunks.get(path);
    if (chunks === undefined) load(anchor);
    else for (const chunk of chunks) prefetchLink(chunk);
  };
  const load = (anchor: HTMLAnchorElement): void => {
    const path = pathOf(anchor);
    if (path === undefined || loaded.has(path)) return;
    loaded.add(path);
    const preloaded = (pageChunks.get(path) ?? []).map((chunk) => import(/* @vite-ignore */ chunk));
    void Promise.all([prefetchPage(router, path), ...preloaded]).catch(() => loaded.delete(path));
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      if (entry.target instanceof HTMLAnchorElement) fetchAhead(entry.target);
    }
  });
  const observeLinks = (): void => {
    observer.disconnect();
    for (const anchor of document.querySelectorAll("a[href]")) observer.observe(anchor);
  };
  const whenIdle = (task: () => void): void => {
    if ("requestIdleCallback" in window) requestIdleCallback(task, { timeout: 2000 });
    else setTimeout(task, 200);
  };
  whenIdle(observeLinks);
  router.afterEach(() => whenIdle(observeLinks));
  const onIntent = (event: Event): void => {
    const anchor = anchorOf(event.target);
    if (anchor !== undefined) load(anchor);
  };
  document.addEventListener("pointerover", onIntent, { passive: true });
  document.addEventListener("touchstart", onIntent, { passive: true });
  document.addEventListener("focusin", onIntent);
};
