import type { Router } from "vue-router";
import { anchorOf, pageHref } from "./links.ts";

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
    if (typeof resolved === "object" && resolved !== null) components["default"] = resolved;
  }
};

/** Loads the pages of the links in view when the browser is idle, and the page of a link under the pointer or the finger at once. */
export const startPrefetch = (router: Router): void => {
  const requested = new Set<string>();
  const request = (anchor: HTMLAnchorElement): void => {
    const href = pageHref(router, anchor);
    if (href === undefined) return;
    const path = new URL(href, location.href).pathname;
    if (requested.has(path) || path === location.pathname) return;
    requested.add(path);
    void prefetchPage(router, path).catch(() => requested.delete(path));
  };
  const observer = new IntersectionObserver((entries) => {
    for (const entry of entries) {
      if (!entry.isIntersecting) continue;
      observer.unobserve(entry.target);
      if (entry.target instanceof HTMLAnchorElement) request(entry.target);
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
    if (anchor !== undefined) request(anchor);
  };
  document.addEventListener("pointerover", onIntent, { passive: true });
  document.addEventListener("touchstart", onIntent, { passive: true });
  document.addEventListener("focusin", onIntent);
};
