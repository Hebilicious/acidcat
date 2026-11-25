export interface Listbox {
  /** The number of options. */
  readonly count: number;
  /** The index of the selected option, or -1. */
  readonly selected: number;
  readonly select: (index: number) => void;
  readonly open: (index: number) => void;
}

/** ArrowDown and ArrowUp select the next and the previous option of a list box, around its ends, and Enter opens the selected option. */
export const onListboxKey = (event: KeyboardEvent, { count, selected, select, open }: Listbox): void => {
  const step = event.key === "ArrowDown" ? 1 : event.key === "ArrowUp" ? -1 : 0;
  if (step !== 0) {
    event.preventDefault();
    if (count > 0) select((selected + step + count) % count);
  } else if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    if (selected > -1 && selected < count) open(selected);
  }
};
