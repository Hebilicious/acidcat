import { listenToTabs, selectTab } from "vaporpress/behaviors";
import { installOncePerDocument } from "./once-per-document.ts";

const storageKey = (syncKey: string) => `acidcat-tabs:${syncKey}`;

const readChoice = (syncKey: string): string | null => {
  try {
    return localStorage.getItem(storageKey(syncKey));
  } catch {
    return null;
  }
};

const saveChoice = (syncKey: string, label: string): void => {
  try {
    localStorage.setItem(storageKey(syncKey), label);
  } catch {
    return;
  }
};

const tabsOf = (group: Element): HTMLAnchorElement[] => [...group.querySelectorAll<HTMLAnchorElement>(':scope > .tablist-wrapper [role="tab"]')];

const select = (group: Element, chosen: HTMLElement): void => selectTab(tabsOf(group), chosen, (tab) => group.querySelector<HTMLElement>(`:scope > #${tab.getAttribute("href")?.slice(1) ?? ""}`));

const selectLabel = (group: Element, label: string): void => {
  const tab = tabsOf(group).find((candidate) => candidate.textContent === label);
  if (tab !== undefined) select(group, tab);
};

/** Selects in each tab group of `root` that has a sync key the tab that the reader chose last for that key. */
export const restoreTabChoices = (root: HTMLElement): void => {
  for (const group of root.querySelectorAll<HTMLElement>(".tabs[data-sync-key]")) {
    const stored = readChoice(group.dataset["syncKey"] ?? "");
    if (stored !== null) selectLabel(group, stored);
  }
};

const choose = (group: HTMLElement, tab: HTMLElement): void => {
  const syncKey = group.dataset["syncKey"];
  const label = tab.textContent;
  if (syncKey === undefined) {
    select(group, tab);
    return;
  }
  saveChoice(syncKey, label);
  for (const other of document.querySelectorAll<HTMLElement>(".tabs[data-sync-key]")) if (other.dataset["syncKey"] === syncKey) selectLabel(other, label);
};

export const selectTabsOnInput = (): void => installOncePerDocument("data-tab-input", () => listenToTabs({ tab: '.tabs [role="tab"]', group: ".tabs", tabsOf, choose }));
