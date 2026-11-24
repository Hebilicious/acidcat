import { onPageUpdated } from "vaporpress/client";
import { onUnmounted } from "vue";
import { initExplorer } from "../lib/code-explorer.ts";
import { mountTabs } from "../theme/tabs.ts";

/** Starts the tabs and the code explorers of each page when its content is in the DOM, and stops them when it leaves. */
export const usePageBehaviors = (): void => {
  let page = new AbortController();
  onPageUpdated(() => {
    page.abort();
    page = new AbortController();
    const content = document.querySelector<HTMLElement>(".markdown-content");
    if (content === null) return;
    mountTabs(content, page.signal);
    for (const explorer of content.querySelectorAll<HTMLElement>("[data-explorer]")) initExplorer(explorer, page.signal);
  });
  onUnmounted(() => page.abort());
};
