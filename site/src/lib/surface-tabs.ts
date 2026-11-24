/** Turns the panels of Fig. 3 into tabs, and tells the hero which surface is under the pointer, until `signal` aborts. */
export const mountSurfaceTabs = (root: HTMLElement, signal: AbortSignal): void => {
  const rail = root.querySelector<HTMLElement>(".surface-tabs");
  if (rail === null) return;
  const tabs = Array.from(rail.querySelectorAll("button"));
  const select = (active: HTMLButtonElement) => {
    for (const tab of tabs) {
      const selected = tab === active;
      tab.setAttribute("aria-selected", String(selected));
      tab.tabIndex = selected ? 0 : -1;
      const panel = root.querySelector<HTMLElement>(`#${tab.getAttribute("aria-controls") ?? ""}`);
      if (panel) {
        panel.inert = !selected;
        panel.tabIndex = 0;
        panel.setAttribute("role", "tabpanel");
        panel.setAttribute("aria-labelledby", tab.id);
      }
    }
  };
  const announce = (detail: string | null) => document.dispatchEvent(new CustomEvent("acidcat:surface", { detail }));
  for (const [index, tab] of tabs.entries()) {
    const signalSurface = () => announce(tab.dataset["surface"] ?? null);
    tab.addEventListener("pointerenter", signalSurface, { signal });
    tab.addEventListener("pointerleave", () => announce(null), { signal });
    tab.addEventListener("focus", signalSurface, { signal });
    tab.addEventListener("blur", () => announce(null), { signal });
    tab.addEventListener("click", () => select(tab), { signal });
    tab.addEventListener(
      "keydown",
      (event) => {
        const targets: Record<string, number> = {
          ArrowRight: (index + 1) % tabs.length,
          ArrowLeft: (index + tabs.length - 1) % tabs.length,
          Home: 0,
          End: tabs.length - 1,
        };
        const targetIndex = targets[event.key];
        const target = targetIndex === undefined ? undefined : tabs[targetIndex];
        if (target) {
          event.preventDefault();
          select(target);
          target.focus();
        }
      },
      { signal },
    );
  }
  if (tabs[0]) select(tabs[0]);
  rail.hidden = false;
};
