/** True when a key typed in the target is text, so the key is not a shortcut. */
export const isTextField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && !["button", "checkbox", "radio", "reset", "submit"].includes(target.type)));

/** Control+K or Command+K anywhere, or `/` outside a text field. */
export const isSearchShortcut = (event: KeyboardEvent): boolean =>
  (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey)) || (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !isTextField(event.target));

export interface Listbox {
  /** The number of options. */
  readonly count: number;
  /** The index of the selected option, or -1. */
  readonly selected: number;
  readonly select: (index: number) => void;
  readonly open: (index: number) => void;
}

/**
 * ArrowDown and ArrowUp select the next and the previous option of a list box, around its ends, and Enter opens the
 * selected option. Returns true when it handled the key.
 */
export const onListboxKey = (event: KeyboardEvent, listbox: Listbox): boolean => {
  const { count, selected } = listbox;
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    if (count > 0) listbox.select((selected + (event.key === "ArrowDown" ? 1 : -1) + count) % count);
    return true;
  }
  if (event.key !== "Enter" || event.isComposing) return false;
  event.preventDefault();
  if (selected > -1 && selected < count) listbox.open(selected);
  return true;
};

/** Opens a dialog as a modal. The function that it returns closes the dialog, and gives the focus back to the element that had it. */
export const openModal = (dialog: HTMLDialogElement): (() => void) => {
  const returnFocus = document.activeElement;
  dialog.showModal();
  return () => {
    dialog.close();
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
  };
};

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

export interface CopyButtons {
  /** The selector of a copy button. */
  readonly button: string;
  /** The element whose text a button copies. */
  readonly code: (button: HTMLElement) => Element | null | undefined;
  /** Runs when a button has copied, and again two seconds later, for example to change its label. */
  readonly copied?: (button: HTMLElement, copied: boolean) => void;
}

/** Copies the text of a code block to the clipboard when the reader clicks its copy button, and gives the button `data-copied` for two seconds. One listener on the document serves every page. */
export const copyCodeOnClick = ({ button, code, copied }: CopyButtons): void => {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(button) : null;
    const text = target === null ? undefined : code(target)?.textContent;
    if (target === null || text === undefined) return;
    void navigator.clipboard.writeText(text).then(() => {
      target.dataset["copied"] = "";
      copied?.(target, true);
      setTimeout(() => {
        delete target.dataset["copied"];
        copied?.(target, false);
      }, 2000);
    });
  });
};

/**
 * Calls `change` with the id of the last heading above a line `line` pixels under the top of the window, or
 * `undefined` when no heading is above it, each time that it changes. The root of the observer reaches far above the
 * window and ends at the line, so a heading intersects exactly when it is above the line, and the page reads no layout.
 * Returns a function that stops the observer.
 */
export const observeActiveHeading = (headings: readonly HTMLElement[], line: number, change: (id: string | undefined) => void): (() => void) => {
  const above = new Map<Element, boolean>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) above.set(entry.target, entry.isIntersecting);
      change(headings.findLast((heading) => above.get(heading) === true)?.id);
    },
    { rootMargin: `100000px 0px ${Math.round(line - innerHeight)}px 0px` },
  );
  for (const heading of headings) observer.observe(heading);
  return () => observer.disconnect();
};
