/** True when a key typed in the target is text, so the key is not a shortcut. */
export const isTextField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement &&
  (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && !["button", "checkbox", "radio", "reset", "submit"].includes(target.type)));

/** Control+K or Command+K anywhere, or `/` outside a text field. */
export const isSearchShortcut = (event: KeyboardEvent): boolean =>
  (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey)) || (event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !isTextField(event.target));
