// One module for each behavior, so a bundler puts each in the chunk that uses it.
export { observeActiveHeading } from "./active-heading.ts";
export { copyCodeOnClick } from "./copy-code.ts";
export type { CopyButtons } from "./copy-code.ts";
export { openDialogOnInput } from "./dialog.ts";
export type { DialogOpeners } from "./dialog.ts";
export { onListboxKey } from "./listbox.ts";
export type { Listbox } from "./listbox.ts";
export { openModal } from "./modal.ts";
export { isSearchShortcut, isTextField } from "./search-shortcut.ts";
export { listenToTabs, selectTab } from "./tabs.ts";
export type { TabGroups } from "./tabs.ts";
