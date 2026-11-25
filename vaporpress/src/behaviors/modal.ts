/** Opens a dialog as a modal. The function that it returns closes the dialog, and gives the focus back to the element that had it. */
export const openModal = (dialog: HTMLDialogElement): (() => void) => {
  const returnFocus = document.activeElement;
  dialog.showModal();
  return () => {
    dialog.close();
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
  };
};
