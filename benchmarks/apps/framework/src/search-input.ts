import { isSearchShortcut, openDialogOnInput } from "framework/behaviors";
import { preloadSearchIndex } from "framework/search";

openDialogOnInput({
  control: ".search-button",
  dialog: "#search",
  shortcut: isSearchShortcut,
  opened: (dialog) => {
    dialog.querySelector("input")?.focus();
    preloadSearchIndex();
  },
});
