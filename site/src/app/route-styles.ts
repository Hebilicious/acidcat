import type { Router } from "vaporpress/client";
import { routeOfPage } from "../lib/routes.ts";
import { applyRouteStyles, fetchRouteStyles, loadRouteFonts, prefetchRoutesAhead } from "../theme/route-styles.ts";

/**
 * Loads the stylesheet and the faces of the next route before the router confirms the page change, and applies the
 * stylesheet when it confirms it. Vue renders the new page in a microtask after the confirmation, before the browser
 * paints, so no frame shows the old page with the new stylesheet.
 */
export const useRouteStyles = (router: Router): void => {
  let pending: HTMLLinkElement | undefined;
  router.beforeResolve(async (to, from) => {
    if (to.path === from.path) return;
    const route = routeOfPage(to.path);
    [pending] = await Promise.all([fetchRouteStyles(route), loadRouteFonts(route)]);
  });
  router.afterEach(() => {
    applyRouteStyles(pending);
    pending = undefined;
  });
  prefetchRoutesAhead();
};
