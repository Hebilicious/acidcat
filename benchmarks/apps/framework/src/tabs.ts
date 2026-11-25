const tabsOf = (group: Element): HTMLElement[] => [...group.querySelectorAll<HTMLElement>('[role="tab"]')];

const select = (group: Element, chosen: Element): void => {
  for (const tab of tabsOf(group)) {
    const selected = tab === chosen;
    tab.setAttribute("aria-selected", String(selected));
    tab.tabIndex = selected ? 0 : -1;
    const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
    if (panel !== null) panel.hidden = !selected;
  }
};

const keys: Readonly<Record<string, (index: number, count: number) => number>> = {
  ArrowRight: (index, count) => (index + 1) % count,
  ArrowLeft: (index, count) => (index - 1 + count) % count,
  Home: () => 0,
  End: (_index, count) => count - 1,
};

export const mountTabs = (root: HTMLElement): void => {
  for (const group of root.querySelectorAll(".tabs")) {
    group.addEventListener("click", (event) => {
      const tab = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
      if (tab !== null) select(group, tab);
    });
    group.addEventListener("keydown", (event) => {
      if (!(event instanceof KeyboardEvent)) return;
      const tabs = tabsOf(group);
      const index = tabs.findIndex((tab) => tab === event.target);
      const step = keys[event.key];
      const target = step === undefined || index === -1 ? undefined : tabs[step(index, tabs.length)];
      if (target === undefined) return;
      event.preventDefault();
      select(group, target);
      target.focus();
    });
  }
};
