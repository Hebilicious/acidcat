import { defineAsyncComponent, getCurrentInstance, onBeforeUnmount } from "vue";
import type { Component } from "vue";
import { nearMargin } from "../lib/gpu/support.ts";

const near = (element: Element): Promise<void> =>
  new Promise((resolve) => {
    const observer = new IntersectionObserver(
      ([entry]) => {
        if (entry?.isIntersecting !== true) return;
        observer.disconnect();
        resolve();
      },
      { rootMargin: nearMargin },
    );
    observer.observe(element);
    // Vue keeps the first promise of the loader for every later mount, so it must settle when the reader leaves early.
    onBeforeUnmount(() => {
      observer.disconnect();
      resolve();
    });
  });

/**
 * A figure of the homepage that loads its code when its HTML from the server comes near the viewport, and hydrates when
 * the code arrives. After a page change in the browser, the figure has no HTML from the server, and it loads at once.
 */
export const nearFigure = (load: () => Promise<{ default: Component }>): Component =>
  defineAsyncComponent(() => {
    if (import.meta.env.SSR) return load();
    // During hydration, Vue gives the component its node from the server before the setup that calls this loader.
    const element: unknown = getCurrentInstance()?.vnode.el;
    return element instanceof Element ? near(element).then(load) : load();
  });
