import { markText } from "framework/search";

const radius = 80;

/** A short excerpt of the text of a section around the first word that matches, as HTML with each match in `<mark>`. */
export const excerptAround = (html: string, terms: readonly string[]): string => {
  const spaced = html.replace(/<\/(p|li|h[1-6]|pre|td|th|tr|div)>/g, "$& ");
  const text = (new DOMParser().parseFromString(spaced, "text/html").body.textContent ?? "").replace(/\s+/g, " ").trim();
  const lower = text.toLowerCase();
  const first = Math.min(...terms.map((term) => lower.indexOf(term.toLowerCase())).filter((index) => index >= 0), text.length);
  const start = first === text.length ? 0 : Math.max(0, first - radius);
  const end = Math.min(text.length, start + 2 * radius);
  return `${start > 0 ? "…" : ""}${markText(text.slice(start, end), terms)}${end < text.length ? "…" : ""}`;
};
