import { mountCatalogEngine } from "./holo.ts";

/** Wires the language buttons and the surface capsules of Fig. 1, and starts its 3D machine, until `signal` aborts. */
export const mountSchematic = (root: HTMLElement, signal: AbortSignal): void => {
  const machine = root.querySelector<HTMLElement>("[data-machine]");
  if (machine !== null) {
    const buttons = machine.querySelectorAll<HTMLButtonElement>("button[data-language]");
    const panels = machine.querySelectorAll<HTMLElement>("[data-fig1-panel]");
    for (const button of buttons) {
      button.addEventListener(
        "click",
        () => {
          for (const other of buttons) other.setAttribute("aria-pressed", String(other === button));
          for (const panel of panels) panel.hidden = panel.id !== button.getAttribute("aria-controls");
          machine.dispatchEvent(new Event("languagechange"));
        },
        { signal },
      );
    }
    mountCatalogEngine(machine, signal);
  }

  const announce = (id: string | null) => {
    document.dispatchEvent(new CustomEvent("acidcat:surface", { detail: id }));
    for (const pipe of root.querySelectorAll<SVGGElement>("[data-surface-pipe]")) {
      pipe.classList.toggle("is-active", pipe.dataset["surfacePipe"] === id);
    }
  };

  for (const capsule of root.querySelectorAll<HTMLElement>("[data-surface]")) {
    const id = capsule.dataset["surface"] ?? null;
    capsule.addEventListener("pointerenter", () => announce(id), { signal });
    capsule.addEventListener("focus", () => announce(id), { signal });
    capsule.addEventListener("pointerleave", () => announce(null), { signal });
    capsule.addEventListener("blur", () => announce(null), { signal });
  }
};
