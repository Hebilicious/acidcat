export interface CopyButtons {
  /** The selector of a copy button. */
  readonly button: string;
  /** The element whose text a button copies. */
  readonly code: (button: HTMLElement) => Element | null | undefined;
  /** Runs when a button has copied, and again two seconds later, for example to change its label. */
  readonly copied?: (button: HTMLElement, copied: boolean) => void;
}

/** Copies the text of a code block to the clipboard when the reader clicks its copy button, and gives the button `data-copied` for two seconds. One listener on the document serves every page. */
export const copyCodeOnClick = ({ button, code, copied }: CopyButtons): void => {
  document.addEventListener("click", (event) => {
    const target = event.target instanceof Element ? event.target.closest<HTMLElement>(button) : null;
    const text = target === null ? undefined : code(target)?.textContent;
    if (target === null || text === undefined) return;
    void navigator.clipboard.writeText(text).then(() => {
      target.dataset["copied"] = "";
      copied?.(target, true);
      setTimeout(() => {
        delete target.dataset["copied"];
        copied?.(target, false);
      }, 2000);
    });
  });
};
