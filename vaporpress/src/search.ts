import { devPageUrl, searchAttribute, searchIgnoreAttribute, searchIndexOptions, searchMetaName } from "./search-shared.ts";
import type { SearchSection } from "./search-shared.ts";

export { searchAttribute, searchIgnoreAttribute } from "./search-shared.ts";

export interface SearchResult {
  /** The URL of the section: the URL of the page, and the id of its heading after `#`. */
  readonly id: string;
  readonly title: string;
  /** The titles of the headings above the section. */
  readonly titles: readonly string[];
  /** The words of the index that match the query, to highlight. */
  readonly terms: readonly string[];
  readonly score: number;
}

export interface SiteSearch {
  /** The sections that match the query, best first. */
  readonly search: (query: string, limit?: number) => SearchResult[];
}

const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string");

const indexUrl = (): string => {
  const url = document.querySelector(`meta[name="${searchMetaName}"]`)?.getAttribute("content");
  if (url === null || url === undefined) throw new Error("The page names no search index. Set `search: true` in the options of vaporpress.");
  return url;
};

const load = async (): Promise<SiteSearch> => {
  const [{ default: MiniSearch }, json] = await Promise.all([
    import("minisearch"),
    fetch(indexUrl()).then(async (response) => {
      if (!response.ok) throw new Error(`The search index did not load: ${response.status}.`);
      return response.text();
    }),
  ]);
  const index = MiniSearch.loadJSON<SearchSection>(json, searchIndexOptions);
  return {
    search: (query, limit = 16) =>
      index
        .search(query)
        .slice(0, limit)
        .flatMap((result) => {
          const id: unknown = result.id;
          const title: unknown = result["title"];
          const titles: unknown = result["titles"];
          if (typeof id !== "string" || typeof title !== "string" || !isStringList(titles)) return [];
          return [{ id, title, titles, terms: result.terms, score: result.score }];
        }),
  };
};

let loading: Promise<SiteSearch> | undefined;

/** Loads the search engine and the index of the site, once. A failed load loads again on the next call. */
export const loadSearch = (): Promise<SiteSearch> => {
  const current = loading ?? load();
  loading = current;
  current.catch(() => {
    if (loading === current) loading = undefined;
  });
  return current;
};

const headingSelector = "h1, h2, h3, h4, h5, h6";

const nextOutside = (node: Element, root: Element): Element | undefined => {
  let current: Element | null = node;
  while (current !== null && current !== root) {
    if (current.nextElementSibling !== null) return current.nextElementSibling;
    current = current.parentElement;
  }
  return undefined;
};

/** The HTML of the content under the heading of a section, up to the next heading. */
export const sectionHtml = (document: Document, id: string): string => {
  const root = document.querySelector(`[${searchAttribute}]`);
  if (root === null) return "";
  const hash = id.indexOf("#");
  const heading = hash === -1 ? root.querySelector(headingSelector) : document.getElementById(decodeURIComponent(id.slice(hash + 1)));
  if (heading === null || !root.contains(heading)) return "";
  const parts: string[] = [];
  let node = nextOutside(heading, root);
  while (node !== undefined && !node.matches(headingSelector)) {
    if (node.querySelector(headingSelector) !== null) {
      node = node.firstElementChild ?? nextOutside(node, root);
      continue;
    }
    if (node.closest(`[${searchIgnoreAttribute}]`) === null) parts.push(node.outerHTML);
    node = nextOutside(node, root);
  }
  return parts.join("");
};

const pages = new Map<string, Promise<Document>>();

/** The HTML of the content of a section, from the HTML file of its page. */
export const loadExcerpt = async (id: string): Promise<string> => {
  const url = id.replace(/#.*$/, "");
  const page =
    pages.get(url) ??
    fetch(import.meta.env.DEV ? `${devPageUrl}?url=${encodeURIComponent(url)}` : url).then(async (response) => {
      if (!response.ok) throw new Error(`The page ${url} did not load: ${response.status}.`);
      return new DOMParser().parseFromString(await response.text(), "text/html");
    });
  pages.set(url, page);
  page.catch(() => pages.delete(url));
  return sectionHtml(await page, id);
};

const escapeRegExp = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

/** Wraps each match of the terms in the text of the HTML in `<mark>`, and returns the HTML. */
export const markTerms = (html: string, terms: readonly string[]): string => {
  const words = [...terms].filter((term) => term !== "").sort((a, b) => b.length - a.length);
  if (words.length === 0) return html;
  const pattern = new RegExp(words.map(escapeRegExp).join("|"), "gi");
  const container = document.createElement("div");
  container.innerHTML = html;
  const walker = document.createTreeWalker(container, NodeFilter.SHOW_TEXT);
  const texts: Text[] = [];
  for (let node = walker.nextNode(); node !== null; node = walker.nextNode()) if (node instanceof Text) texts.push(node);
  for (const text of texts) {
    const value = text.data;
    const parts: Node[] = [];
    let last = 0;
    for (const match of value.matchAll(pattern)) {
      if (match.index > last) parts.push(document.createTextNode(value.slice(last, match.index)));
      const mark = document.createElement("mark");
      mark.textContent = match[0];
      parts.push(mark);
      last = match.index + match[0].length;
    }
    if (parts.length === 0) continue;
    if (last < value.length) parts.push(document.createTextNode(value.slice(last)));
    text.replaceWith(...parts);
  }
  return container.innerHTML;
};

/** Wraps each match of the terms in the text in `<mark>`, and returns HTML. */
export const markText = (text: string, terms: readonly string[]): string => markTerms(escapeHtml(text), terms);
