/** Copies the code of a code block when the reader clicks its copy button. One listener serves every page. */
export const copyCodeOnClick = (): void => {
  addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>(".copy-code") : null;
    const code = button?.parentElement?.querySelector("pre code");
    if (button === null || button === undefined || code === null || code === undefined) return;
    void navigator.clipboard.writeText(code.textContent).then(() => {
      button.dataset["copied"] = "";
      button.setAttribute("aria-label", "Copied");
      setTimeout(() => {
        delete button.dataset["copied"];
        button.setAttribute("aria-label", "Copy code");
      }, 2000);
    });
  });
};
