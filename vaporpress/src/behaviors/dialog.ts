export interface DialogOpeners {
  /** The selector of the controls that open the dialog. */
  readonly control: string;
  /** The selector of the dialog. The listeners look for it at each event, so a dialog that a page change adds needs nothing more. */
  readonly dialog: string;
  /** True for a key that opens the dialog, for example `isSearchShortcut`. */
  readonly shortcut?: (event: KeyboardEvent) => boolean;
  /** Runs after the dialog opens, for example to focus its field and to start the loads that it needs. */
  readonly opened?: (dialog: HTMLDialogElement) => void;
}

/**
 * Opens a dialog of the page as a modal when the reader clicks one of its controls or presses its shortcut, with one
 * click listener and one keydown listener on the document. It does nothing when the dialog is open already, so the
 * component that owns the dialog can open it too. It uses only the DOM, so an inline script can run it before the app
 * hydrates, and the dialog in the HTML from the server answers at once.
 */
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
