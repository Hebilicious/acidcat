import { isSearchShortcut, openDialogOnInput } from "vaporpress/behaviors";
import { installOncePerDocument } from "./once-per-document.ts";

export const searchQueryKey = "acidcat:search-query";

export const readStorage = (storage: () => Storage, key: string): string | null => {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
};

const focusField = (dialog: HTMLDialogElement): void => {
  const input = dialog.querySelector("input");
  if (input === null) return;
  if (input.value === "") input.value = readStorage(() => sessionStorage, searchQueryKey) ?? "";
  input.focus();
  input.select();
};

export const openSearchOnInput = (loadAhead?: () => void): void =>
  installOncePerDocument("data-search-input", () =>
    openDialogOnInput({
      control: ".search-button",
      dialog: "#search-dialog",
      shortcut: isSearchShortcut,
      opened: (dialog) => {
        focusField(dialog);
        loadAhead?.();
      },
    }),
  );
