import { onPageUpdated } from "vaporpress/client";
import { onUnmounted } from "vue";
import { mountTabs } from "../theme/tabs.ts";

export const usePageBehaviors = (): void => {
  let page = new AbortController();
  onPageUpdated(() => {
    page.abort();
    page = new AbortController();
    const content = document.querySelector<HTMLElement>(".markdown-content");
    if (content === null) return;
    mountTabs(content, page.signal);
    const explorers = content.querySelectorAll<HTMLElement>("[data-explorer]");
    if (explorers.length === 0) return;
    const { signal } = page;
    void import("../lib/code-explorer.ts").then(({ initExplorer }) => {
      for (const explorer of explorers) if (!signal.aborted) initExplorer(explorer, signal);
    });
  });
  onUnmounted(() => page.abort());
};
