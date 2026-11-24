import type { App, VaporComponent } from "vue";
import type { Router, RouterScrollBehavior } from "vue-router";
import type { HeadDefinition } from "./head.ts";

export interface SiteDefinition extends HeadDefinition {
  /** The root component: the layout of the site. It shows the page with `<RouterView />`. */
  readonly layout: VaporComponent;
  /** Changes the scroll position after a page change. The default restores the position of a page that the reader comes back to, goes to the heading of a hash, or goes to the top. */
  readonly scrollBehavior?: RouterScrollBehavior;
  /** Runs once in the browser and once for each page on the server, before the first render. */
  readonly enhance?: (context: { readonly app: App; readonly router: Router }) => void | Promise<void>;
}

export const defineSite = (site: SiteDefinition): SiteDefinition => site;

const isOptionalFunction = (value: unknown): boolean => value === undefined || typeof value === "function";

const isSiteDefinition = (value: unknown): value is SiteDefinition =>
  typeof value === "object" &&
  value !== null &&
  "layout" in value &&
  (typeof value.layout === "object" || typeof value.layout === "function") &&
  value.layout !== null &&
  ["title", "head", "scrollBehavior", "enhance"].every((key) => isOptionalFunction(Reflect.get(value, key)));

export const readSite = (value: unknown): SiteDefinition => {
  if (!isSiteDefinition(value)) throw new Error("The app module of the site must export the result of defineSite as its default export.");
  return value;
};
