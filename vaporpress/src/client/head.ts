import type { HeadTag, PageData } from "../page.ts";

export const headMarker = "data-page-head";

export interface HeadDefinition {
  /** The title of the document for a page. */
  readonly title?: (page: PageData) => string;
  /** The elements of the head that change with the page, such as the description and the canonical link. */
  readonly head?: (page: PageData) => readonly HeadTag[];
}

const escapeText = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;");
const escapeAttribute = (text: string): string => escapeText(text).replaceAll('"', "&quot;");

export const documentTitle = (site: HeadDefinition, page: PageData): string => site.title?.(page) ?? page.title;

export const renderHead = (site: HeadDefinition, page: PageData): string => {
  const tags = (site.head?.(page) ?? []).map((tag) => {
    const attrs = Object.entries({ ...tag.attrs, [headMarker]: "" })
      .map(([name, value]) => (value === "" ? ` ${name}` : ` ${name}="${escapeAttribute(value)}"`))
      .join("");
    return tag.tag === "meta" || tag.tag === "link" ? `<${tag.tag}${attrs}>` : `<${tag.tag}${attrs}>${tag.children ?? ""}</${tag.tag}>`;
  });
  return [`<title>${escapeText(documentTitle(site, page))}</title>`, ...tags].join("");
};

export const updateHead = (site: HeadDefinition, page: PageData): void => {
  document.title = documentTitle(site, page);
  for (const element of document.head.querySelectorAll(`[${headMarker}]`)) element.remove();
  for (const tag of site.head?.(page) ?? []) {
    const element = document.createElement(tag.tag);
    for (const [name, value] of Object.entries(tag.attrs)) element.setAttribute(name, value);
    element.setAttribute(headMarker, "");
    if (tag.children !== undefined) element.textContent = tag.children;
    document.head.append(element);
  }
};
