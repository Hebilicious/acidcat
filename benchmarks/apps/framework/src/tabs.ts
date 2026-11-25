const select = (group: Element, chosen: Element): void => {
  for (const tab of group.querySelectorAll('[role="tab"]')) {
    const selected = tab === chosen;
    tab.setAttribute("aria-selected", String(selected));
    const panel = document.getElementById(tab.getAttribute("aria-controls") ?? "");
    if (panel !== null) panel.hidden = !selected;
  }
};

export const mountTabs = (root: HTMLElement): void => {
  for (const group of root.querySelectorAll(".tabs")) {
    group.addEventListener("click", (event) => {
      const tab = event.target instanceof Element ? event.target.closest('[role="tab"]') : null;
      if (tab !== null) select(group, tab);
    });
  }
};
