export interface DialogOpeners {
  readonly control: string;
  readonly dialog: string;
  readonly shortcut?: (event: KeyboardEvent) => boolean;
  readonly opened?: (dialog: HTMLDialogElement) => void;
}

export const openDialogOnInput = ({ control, dialog, shortcut, opened }: DialogOpeners): void => {
  const open = (event: Event): void => {
    const element = document.querySelector(dialog);
    if (!(element instanceof HTMLDialogElement)) return;
    event.preventDefault();
    if (element.open) return;
    element.showModal();
    opened?.(element);
  };
  document.addEventListener("click", (event) => {
    if (event.target instanceof Element && event.target.closest(control) !== null) open(event);
  });
  if (shortcut !== undefined)
    document.addEventListener("keydown", (event) => {
      if (shortcut(event)) open(event);
    });
};
