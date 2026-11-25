/**
 * Opens a dialog as a modal. The function that it returns closes the dialog, and gives the focus back to the element
 * that had it. A dialog that is open already, for example from `openDialogOnInput` before the app hydrated, stays as
 * it is: the browser gives the focus back to the element that had it before the dialog opened.
 */
export const openModal = (dialog: HTMLDialogElement): (() => void) => {
  const returnFocus = dialog.open ? null : document.activeElement;
  if (!dialog.open) dialog.showModal();
  return () => {
    dialog.close();
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
  };
};
