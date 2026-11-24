/** The parts of the site that have a stylesheet of their own, in the order of the CSS. Every page shares the rest of the CSS. */
export const routes = ["docs", "search", "home"] as const;
export type Route = (typeof routes)[number];

export const routeOfPage = (path: string): Route => (path === "/" ? "home" : "docs");

export const isRoute = (name: string | undefined): name is Route => routes.some((route) => route === name);
