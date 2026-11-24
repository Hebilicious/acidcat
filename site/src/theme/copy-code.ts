/** Copies the code of a code block when the reader clicks its copy button. One listener serves every page. */
export const copyCodeOnClick = (): void => {
  window.addEventListener("click", (event) => {
    const button = event.target instanceof Element ? event.target.closest<HTMLButtonElement>("[data-copy-code]") : null;
    const code = button?.closest("figure")?.querySelector("pre code");
    if (button === null || button === undefined || code === null || code === undefined) return;
    void navigator.clipboard.writeText(code.textContent).then(() => {
      button.dataset["copied"] = "";
      window.setTimeout(() => delete button.dataset["copied"], 2000);
    });
  });
};
