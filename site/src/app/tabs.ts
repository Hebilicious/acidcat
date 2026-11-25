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

/** Selects in each tab group of `root` that has a sync key the tab that the reader chose last for that key. */
export const restoreTabChoices = (root: HTMLElement): void => {
  for (const group of root.querySelectorAll<HTMLElement>(".tabs[data-sync-key]")) {
    const stored = readChoice(group.dataset["syncKey"] ?? "");
    if (stored !== null) selectLabel(group, stored);
  }
};

const choose = (group: HTMLElement, tab: HTMLAnchorElement): void => {
  const syncKey = group.dataset["syncKey"];
  const label = tab.textContent;
  if (syncKey === undefined) {
    select(group, tab);
    return;
  }
  saveChoice(syncKey, label);
  for (const other of document.querySelectorAll<HTMLElement>(".tabs[data-sync-key]")) if (other.dataset["syncKey"] === syncKey) selectLabel(other, label);
};

const tabOf = (event: Event): { readonly tab: HTMLAnchorElement; readonly group: HTMLElement } | undefined => {
  const tab = event.target instanceof Element ? event.target.closest<HTMLAnchorElement>('.tabs [role="tab"]') : null;
  const group = tab?.closest<HTMLElement>(".tabs");
  return tab === null || tab === undefined || group === null || group === undefined ? undefined : { tab, group };
};

let listening = false;

/**
 * Gives every tab group its behavior with one listener on the document, once, so a tab responds before the content of
 * the page hydrates: a click or an arrow key selects a tab, and the choice in a group with a sync key applies to each
 * group with that key, on this page and on the next ones.
 */
export const selectTabsOnInput = (): void => {
  if (listening) return;
  listening = true;
  document.addEventListener("click", (event) => {
    const found = tabOf(event);
    if (found === undefined) return;
    event.preventDefault();
    choose(found.group, found.tab);
  });
  document.addEventListener("keydown", (event) => {
    const found = tabOf(event);
    if (found === undefined) return;
    const tabs = tabsOf(found.group);
    const index = tabs.indexOf(found.tab);
    const targets: Readonly<Record<string, number>> = { ArrowRight: (index + 1) % tabs.length, ArrowLeft: (index + tabs.length - 1) % tabs.length, Home: 0, End: tabs.length - 1 };
    const target = tabs[targets[event.key] ?? -1];
    if (target === undefined) return;
    event.preventDefault();
    choose(found.group, target);
    target.focus();
  });
};
