import { listenToTabs, selectTab } from "framework/behaviors";

const tabsOf = (group: Element): HTMLElement[] => [...group.querySelectorAll<HTMLElement>('[role="tab"]')];

/** Gives every tab group of every page its behavior, with one listener on the document. */
export const listenToTabGroups = (): void =>
  listenToTabs({ tab: '.tabs [role="tab"]', group: ".tabs", tabsOf, choose: (group, tab) => selectTab(tabsOf(group), tab, (each) => document.getElementById(each.getAttribute("aria-controls") ?? "")) });
