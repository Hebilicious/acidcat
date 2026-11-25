// For a dialog that was open already, the browser gives the focus back on close() to the element that had it before the dialog opened.
export const openModal = (dialog: HTMLDialogElement): (() => void) => {
  const returnFocus = dialog.open ? null : document.activeElement;
  if (!dialog.open) dialog.showModal();
  return () => {
    dialog.close();
    if (returnFocus instanceof HTMLElement) returnFocus.focus();
  };
};
