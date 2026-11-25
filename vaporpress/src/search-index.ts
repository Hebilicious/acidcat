import { createHash } from "node:crypto";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import type { Element, ElementContent, Root, RootContent } from "hast";
import { fromHtml } from "hast-util-from-html";
import MiniSearch from "minisearch";
import { searchAttribute, searchIgnoreAttribute, searchIndexOptions, searchMetaName } from "./search-shared.ts";
import type { SearchSection } from "./search-shared.ts";

export interface IndexedPage {
  /** The URL of the page, such as `/guide/setup/`. */
  readonly url: string;
  /** The HTML of the page, as the build writes it. */
  readonly html: string;
}

const headingLevel = (node: Element): number | undefined => {
  const match = /^h([1-6])$/.exec(node.tagName);
  return match?.[1] === undefined ? undefined : Number(match[1]);
};

const hasAttribute = (node: Element, name: string): boolean => {
  const property = name.replace(/-([a-z])/g, (_, letter: string) => letter.toUpperCase());
  return node.properties[property] !== undefined && node.properties[property] !== false;
};

const skippedTags: ReadonlySet<string> = new Set(["script", "style", "template", "noscript"]);
const inlineTags: ReadonlySet<string> = new Set(["a", "abbr", "b", "code", "em", "i", "kbd", "mark", "s", "small", "span", "strong", "sub", "sup", "u"]);

const findSearchRoot = (node: Root | Element): Element | undefined => {
  for (const child of node.children) {
    if (child.type !== "element") continue;
    if (hasAttribute(child, searchAttribute)) return child;
    const found = findSearchRoot(child);
    if (found !== undefined) return found;
  }
  return undefined;
};

const textOf = (node: RootContent | ElementContent): string => {
  if (node.type === "text") return node.value;
  if (node.type !== "element" || skippedTags.has(node.tagName) || hasAttribute(node, searchIgnoreAttribute)) return "";
  const text = node.children.map(textOf).join("");
  return inlineTags.has(node.tagName) ? text : ` ${text} `;
};

const clean = (text: string): string => text.replace(/\s+/g, " ").trim();

/** Splits the content of a page into one section for each heading, as the reader finds them: the title of the heading, the titles of the headings above it, and the text under it. */
export const pageSections = (page: IndexedPage): SearchSection[] => {
  const root = findSearchRoot(fromHtml(page.html));
  if (root === undefined) return [];
  const sections: { anchor: string | undefined; titles: string[]; text: string[] }[] = [];
  let parents: string[] = [];
  let first = true;
  const visit = (node: ElementContent): void => {
    if (node.type === "text") {
      sections.at(-1)?.text.push(node.value);
      return;
    }
    if (node.type !== "element" || skippedTags.has(node.tagName) || hasAttribute(node, searchIgnoreAttribute)) return;
    const level = headingLevel(node);
    if (level !== undefined) {
      const title = clean(node.children.map(textOf).join(""));
      const id = node.properties["id"];
      const anchor = first || typeof id !== "string" ? undefined : id;
      first = false;
      const titles = parents.slice(0, level - 1);
      titles[level - 1] = title;
      sections.push({ anchor, titles: titles.filter((part) => part !== undefined && part !== ""), text: [] });
      parents = [...titles];
      return;
    }
    const block = !inlineTags.has(node.tagName);
    if (block) sections.at(-1)?.text.push(" ");
    for (const child of node.children) visit(child);
    if (block) sections.at(-1)?.text.push(" ");
  };
  for (const child of root.children) visit(child);
  return sections
    .map((section) => ({ ...section, text: clean(section.text.join("")) }))
    .filter((section) => section.text !== "" && section.titles.length > 0)
    .map((section) => ({
      id: section.anchor === undefined ? page.url : `${page.url}#${section.anchor}`,
      title: section.titles.at(-1) ?? "",
      titles: section.titles.slice(0, -1),
      text: section.text,
    }));
};

/** The search index of the pages, as JSON for `MiniSearch.loadJSON`. */
export const searchIndexJson = (pages: readonly IndexedPage[]): string => {
  const index = new MiniSearch<SearchSection>(searchIndexOptions);
  index.addAll(pages.flatMap(pageSections));
  return JSON.stringify(index);
};

/** Writes the search index into the assets of the build, with the hash of its content in its name, and returns its URL. */
export const writeSearchIndex = async (outDir: string, assetsDir: string, json: string): Promise<string> => {
  const hash = createHash("sha256").update(json).digest("base64url").slice(0, 8);
  const file = `${assetsDir}/search.${hash}.json`;
  await mkdir(join(outDir, assetsDir), { recursive: true });
  await writeFile(join(outDir, file), json);
  return `/${file}`;
};

export const searchMeta = (url: string): string => `<meta name="${searchMetaName}" content="${url}">`;
