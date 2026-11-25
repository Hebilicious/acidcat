import { defineVaporAsyncComponent, hasInjectionContext } from "vue";
import type { VaporComponent } from "vue";
import type { PageData } from "../page.ts";

interface LazyLayout {
  readonly load: () => Promise<unknown>;
  readonly usedBy: (page: PageData) => boolean;
}

const lazyLayouts: LazyLayout[] = [];

const isLoader = (value: unknown): value is () => Promise<unknown> => typeof value === "function";

/**
 * A layout in a chunk of its own, for the pages for which `usedBy(page)` is true. The router loads it before it changes
 * to such a page, so the layout renders in the same task that removes the page before it. Call it once, when a module
 * loads, so the router knows the layout before the first page.
 */
export const defineLazyLayout = <T extends VaporComponent>(loader: () => Promise<T | { readonly default: T }>, usedBy: (page: PageData) => boolean): T => {
  if (hasInjectionContext()) throw new Error("Call defineLazyLayout at the top level of a module, such as a plain <script> block, not in the setup of a component.");
  const component = defineVaporAsyncComponent(loader);
  // An async component of Vue renders at once only when its own loader has resolved; another import of the same module does not tell it.
  const load: unknown = Reflect.get(component, "__asyncLoader");
  if (!isLoader(load)) throw new Error("This version of Vue gives no loader for an async component.");
  lazyLayouts.push({ load, usedBy });
  return component;
};

export const loadLazyLayouts = async (page: PageData): Promise<void> => {
  await Promise.all(lazyLayouts.filter((layout) => layout.usedBy(page)).map((layout) => layout.load()));
};
