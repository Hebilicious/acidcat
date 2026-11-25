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
