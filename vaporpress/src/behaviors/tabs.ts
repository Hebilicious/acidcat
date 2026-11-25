export interface TabGroups {
  /** The selector of a tab. */
  readonly tab: string;
  /** The selector of the group of a tab: its closest ancestor that matches. */
  readonly group: string;
  /** The tabs of a group, in their order. */
  readonly tabsOf: (group: HTMLElement) => readonly HTMLElement[];
  /** Selects a tab, for example with `selectTab`. */
  readonly choose: (group: HTMLElement, tab: HTMLElement) => void;
}

const tabKeys: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

/**
 * Gives every tab group its behavior with one click listener and one keydown listener on the document, so a group
 * that a page change adds needs nothing more: a click chooses a tab, and ArrowRight, ArrowLeft, Home and End choose
 * a tab and move the focus to it.
 */
export const listenToTabs = ({ tab, group, tabsOf, choose }: TabGroups): void => {
  const tabOf = (event: Event): { readonly tab: HTMLElement; readonly group: HTMLElement } | undefined => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(tab) : null;
    const parent = target?.closest<HTMLElement>(group);
    return target === null || target === undefined || parent === null || parent === undefined ? undefined : { tab: target, group: parent };
  };
  document.addEventListener("click", (event) => {
    const found = tabOf(event);
    if (found === undefined) return;
    event.preventDefault();
    choose(found.group, found.tab);
  });
  document.addEventListener("keydown", (event) => {
    const found = tabOf(event);
    const step = tabKeys[event.key];
    if (found === undefined || step === undefined) return;
    const tabs = tabsOf(found.group);
    const target = tabs[step(tabs.indexOf(found.tab), tabs.length)];
    if (target === undefined) return;
    event.preventDefault();
    choose(found.group, target);
    target.focus();
  });
};

/** Marks one tab of a group as selected, and shows its panel: the other tabs leave the tab order, and their panels hide. */
export const selectTab = (tabs: readonly HTMLElement[], chosen: HTMLElement, panelOf: (tab: HTMLElement) => HTMLElement | null): void => {
  for (const tab of tabs) {
    const selected = tab === chosen;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = panelOf(tab);
    if (panel !== null) panel.hidden = !selected;
  }
};
