import { onContentUpdated } from "vitepress";
import { onUnmounted } from "vue";
import { initExplorer } from "../lib/code-explorer.ts";
import { mountTabs } from "./tabs.ts";

/**
 * Vue keeps static HTML as one string only when each attribute is a known HTML attribute, and `role` is not one. So the
 * components of the docs write `data-role`, and the page gives each element its role when the content mounts. It also
 * starts the tabs and the code explorers of each page when its content is in the DOM, and stops them when it leaves. */
export const usePageBehaviors = (): void => {
  let page = new AbortController();
  onContentUpdated(() => {
    page.abort();
    page = new AbortController();
    const content = document.querySelector<HTMLElement>(".markdown-content");
    if (content === null) return;
    for (const element of content.querySelectorAll<HTMLElement>("[data-role]")) element.setAttribute("role", element.dataset["role"] ?? "");
    mountTabs(content, page.signal);
    for (const explorer of content.querySelectorAll<HTMLElement>("[data-explorer]")) initExplorer(explorer, page.signal);
  });
  onUnmounted(() => page.abort());
};
