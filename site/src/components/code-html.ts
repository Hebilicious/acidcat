import type { Directive } from "vue";
import { onNear } from "../lib/gpu/support.ts";

const loadHtml = (): Promise<Readonly<Record<string, string>>> => import("./home-code.data.ts").then((module) => module.data);

const serverHtml = import.meta.env.SSR ? await loadHtml() : undefined;
const lifetimes = new WeakMap<HTMLElement, AbortController>();

/**
 * Writes the highlighted code of a panel of the homepage, by its name. The server writes it into the HTML, so the
 * JavaScript of the page does not carry it: Vue keeps the children of an element that has none in the browser. After a
 * page change in the browser, the element is empty, and the directive loads the code from its own chunk when the
 * element comes near the viewport.
 */
export const vCodeHtml: Directive<HTMLElement, string> = {
  getSSRProps: (binding) => ({ innerHTML: serverHtml?.[binding.value] ?? "" }),
  mounted: (element, binding) => {
    if (element.childElementCount > 0) return;
    const lifetime = new AbortController();
    lifetimes.set(element, lifetime);
    onNear(element, lifetime.signal, () => {
      void loadHtml().then((html) => {
        if (!lifetime.signal.aborted) element.innerHTML = html[binding.value] ?? "";
      });
    });
  },
  unmounted: (element) => lifetimes.get(element)?.abort(),
};
