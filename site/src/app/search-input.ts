import { isSearchShortcut, openDialogOnInput } from "vaporpress/behaviors";
import { preloadSearchIndex } from "vaporpress/search";

export const searchQueryKey = "acidcat:search-query";

export const readStorage = (storage: () => Storage, key: string): string | null => {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
};

/** The field of the search dialog shows the last query of the tab, selected, so the reader can type a new one or keep it. */
const focusField = (dialog: HTMLDialogElement): void => {
  const input = dialog.querySelector("input");
  if (input === null) return;
  if (input.value === "") input.value = readStorage(() => sessionStorage, searchQueryKey) ?? "";
  input.focus();
  input.select();
  preloadSearchIndex();
};

/**
 * Opens the search dialog that each docs page has in its HTML when the reader clicks the search button or presses a
 * shortcut. The HTML of each docs page runs it inline (`page-input.ts`), so the search opens before any module script
 * runs, and the layout of the docs runs it for a page that the reader reached from the homepage. The attribute on the
 * root element keeps it to one listener, because the inline copy and the module copy do not share their variables.
 */
export const openSearchOnInput = (): void => {
  const root = document.documentElement;
  if (root.hasAttribute("data-search-input")) return;
  root.setAttribute("data-search-input", "");
  openDialogOnInput({ control: ".search-button", dialog: "#search-dialog", shortcut: isSearchShortcut, opened: focusField });
};
