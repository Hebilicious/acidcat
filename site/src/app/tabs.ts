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

const select = (group: Element, chosen: HTMLAnchorElement): void => {
  for (const tab of tabsOf(group)) {
    const selected = tab === chosen;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = group.querySelector<HTMLElement>(`:scope > #${tab.getAttribute("href")?.slice(1) ?? ""}`);
    if (panel !== null) panel.hidden = !selected;
  }
};

const selectLabel = (group: Element, label: string): void => {
  const tab = tabsOf(group).find((candidate) => candidate.textContent === label);
  if (tab !== undefined) select(group, tab);
};

/**
 * Gives the tab groups of the content their behavior: a click or an arrow key selects a tab, and the choice in a group
 * with a sync key applies to each group with that key, on this page and on the next ones.
 */
export const mountTabs = (root: HTMLElement, signal: AbortSignal): void => {
  const groups = [...root.querySelectorAll<HTMLElement>(".tabs")];
  for (const group of groups) {
    const syncKey = group.dataset["syncKey"];
    const stored = syncKey === undefined ? null : readChoice(syncKey);
    if (stored !== null) selectLabel(group, stored);
  }
  const choose = (group: HTMLElement, tab: HTMLAnchorElement) => {
    const syncKey = group.dataset["syncKey"];
    const label = tab.textContent;
    if (syncKey === undefined) {
      select(group, tab);
      return;
    }
    saveChoice(syncKey, label);
    for (const other of groups) if (other.dataset["syncKey"] === syncKey) selectLabel(other, label);
  };
  root.addEventListener(
    "click",
    (event) => {
      const tab = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.tabs [role="tab"]') : null;
      const group = tab?.closest<HTMLElement>(".tabs");
      if (tab === null || tab === undefined || group === null || group === undefined) return;
      event.preventDefault();
      choose(group, tab);
    },
    { signal },
  );
  root.addEventListener(
    "keydown",
    (event) => {
      const tab = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.tabs [role="tab"]') : null;
      const group = tab?.closest<HTMLElement>(".tabs");
      if (tab === null || tab === undefined || group === null || group === undefined) return;
      const tabs = tabsOf(group);
      const index = tabs.indexOf(tab);
      const targets: Readonly<Record<string, number>> = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
      const target = tabs[targets[event.key] ?? -1];
      if (target === undefined) return;
      event.preventDefault();
      choose(group, target);
      target.focus();
    },
    { signal },
  );
};
