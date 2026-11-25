import type { VaporDirective } from "vue";
import { onNear } from "../lib/gpu/support.ts";

const loadHtml = (): Promise<Readonly<Record<string, string>>> => import("../components/home-code.data.ts").then((module) => module.data);

const serverHtml = import.meta.env.SSR ? await loadHtml() : undefined;

const mount: VaporDirective<HTMLElement, string> = (element, name) => {
  if (element.childElementCount > 0) return;
  const lifetime = new AbortController();
  onNear(element, lifetime.signal, () => {
    void loadHtml().then((html) => {
      if (!lifetime.signal.aborted) element.innerHTML = html[name?.() ?? ""] ?? "";
    });
  });
  return () => lifetime.abort();
};

/**
 * Writes the highlighted code of a panel of the homepage, by its name. The server writes it into the HTML, so the
 * JavaScript of the page does not carry it: hydration keeps the children that the server wrote in an element that the
 * template leaves empty. After a page change in the browser, the element is empty, and the directive loads the code
 * from its own chunk when the element comes near the viewport.
 */
export const vCodeHtml = Object.assign(mount, { getSSRProps: (binding: { readonly value: string }) => ({ innerHTML: serverHtml?.[binding.value] ?? "" }) });
