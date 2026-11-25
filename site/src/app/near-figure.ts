import { defineVaporAsyncComponent } from "vue";
import type { VaporComponent } from "vue";
import { nearMargin } from "../lib/gpu/support.ts";

const pending = new Set<() => void>();

const near = (element: Element): Promise<void> =>
  new Promise((resolve) => {
    const release = (): void => {
      observer.disconnect();
      pending.delete(release);
      resolve();
    };
    const observer = new IntersectionObserver(([entry]) => {
      if (entry?.isIntersecting === true) release();
    }, { rootMargin: nearMargin });
    observer.observe(element);
    pending.add(release);
  });

/** Stops watching the figures that did not come near. Vue keeps the first promise of a loader for every later mount, so each one settles. */
export const releaseNearFigures = (): void => {
  for (const release of pending) release();
};

/**
 * A figure of the homepage that loads its code when its HTML from the server, the element at `selector`, comes near the
 * viewport, and hydrates when the code arrives. After a page change in the browser, the page has no HTML of the figure
 * from the server, and the figure loads at once.
 */
export const nearFigure = (selector: string, loader: () => Promise<{ default: VaporComponent }>) =>
  defineVaporAsyncComponent(() => {
    const element = import.meta.env.SSR ? null : document.querySelector(selector);
    return element === null ? loader() : near(element).then(loader);
  });
