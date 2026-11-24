import { createBluescreen, supportsHtmlInCanvas } from "./bluescreen.ts";

/** Wires the vertical tabs of Fig. 4, and draws its console as a blue screen, until `signal` aborts. */
export const mountCoreConsole = (root: HTMLElement, signal: AbortSignal): void => {
  const screen = root.querySelector<HTMLElement>("[data-console-screen]");
  const tabs = Array.from(root.querySelectorAll<HTMLButtonElement>("[data-core-tab]"));
  const still = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
  const bluescreen = screen !== null && supportsHtmlInCanvas() ? createBluescreen(screen, { intensity: 0.45, revealMs: 900, replayMs: 380, still }, signal) : undefined;
  const select = (tab: HTMLButtonElement) => {
    for (const other of tabs) {
      const selected = other === tab;
      other.setAttribute("aria-selected", String(selected));
      other.tabIndex = selected ? 0 : -1;
      const panel = root.querySelector<HTMLElement>(`#${other.getAttribute("aria-controls") ?? ""}`);
      if (panel !== null) panel.hidden = !selected;
    }
    void bluescreen?.then((created) => created?.replay());
  };
  for (const [index, tab] of tabs.entries()) {
    tab.addEventListener("click", () => select(tab), { signal });
    tab.addEventListener(
      "keydown",
      (event) => {
        const forward = event.key === "ArrowDown" || event.key === "ArrowRight";
        const backward = event.key === "ArrowUp" || event.key === "ArrowLeft";
        if (!forward && !backward) return;
        event.preventDefault();
        const next = tabs[(index + (forward ? 1 : tabs.length - 1)) % tabs.length];
        if (next === undefined) return;
        next.focus();
        select(next);
      },
      { signal },
    );
  }
};
