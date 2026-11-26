import { copyCodeOnClick } from "vaporpress/behaviors";
import { onPageUpdated } from "vaporpress/client";
import { onUnmounted } from "vue";
import { openSearchOnInput } from "./search-input.ts";
import { restoreTabChoices, selectTabsOnInput } from "./tabs.ts";

let copying = false;

/** Only the pages of the docs have code blocks with a copy button, so the homepage does not load this code. */
const copyCode = (): void => {
  if (copying) return;
  copying = true;
  copyCodeOnClick({ button: "[data-copy-code]", code: (button) => button.closest("figure")?.querySelector("pre code") });
};

export const usePageBehaviors = (): void => {
  if (!import.meta.env.SSR) {
    selectTabsOnInput();
    openSearchOnInput();
    copyCode();
  }
  let page = new AbortController();
  onPageUpdated(() => {
    page.abort();
    page = new AbortController();
    const content = document.querySelector<HTMLElement>(".markdown-content");
    if (content === null) return;
    restoreTabChoices(content);
    const explorers = content.querySelectorAll<HTMLElement>("[data-explorer]");
    if (explorers.length === 0) return;
    const { signal } = page;
    void import("../lib/code-explorer.ts").then(({ initExplorer }) => {
      for (const explorer of explorers) if (!signal.aborted) initExplorer(explorer, signal);
    });
  });
  onUnmounted(() => page.abort());
};
