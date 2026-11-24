const terminalLanguages: ReadonlySet<string> = new Set(["sh", "bash", "shell", "shellscript", "zsh", "console", "powershell"]);

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const titleAttribute = /(?:^|\s)title="([^"]*)"/;

/** The title of a code block, from `title="…"` in the info string of its fence. */
export const frameTitle = (info: string): string | undefined => titleAttribute.exec(info)?.[1];

/** The info string of a fence without its title. */
export const withoutTitle = (info: string): string => info.replace(titleAttribute, "");

/** Puts the colored HTML of a code block in a frame: an editor tab when it has a title, a terminal for a shell, and a copy button. */
export const codeFrame = (code: string, language: string, title: string | undefined): string => {
  const terminal = terminalLanguages.has(language);
  const classes = ["frame", ...(title === undefined ? [] : ["has-title"]), ...(terminal ? ["is-terminal"] : [])].join(" ");
  const header = title !== undefined || terminal ? `<figcaption class="header"><span class="title">${escapeHtml(title ?? "")}</span></figcaption>` : "";
  const copy = '<div class="copy"><button type="button" title="Copy to clipboard" data-copy-code><span class="sr-only">Copy to clipboard</span></button></div>';
  return `<div class="code-block not-content"><figure class="${classes}" data-language="${escapeHtml(language)}">${header}${code}${copy}</figure></div>`;
};
