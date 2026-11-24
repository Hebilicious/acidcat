import type { Options } from "minisearch";

/** The attribute of the element whose content the search indexes. A page without it is not in the index. */
export const searchAttribute = "data-search";
/** The attribute of an element inside the content that the search leaves out, such as the footer of a page. */
export const searchIgnoreAttribute = "data-search-ignore";
/** The name of the meta element that gives each page the URL of the search index. */
export const searchMetaName = "vaporpress:search";
/** The URL of the search index on the dev server. */
export const devSearchIndexUrl = "/@vaporpress/search.json";
/** The URL of the HTML of a page that the dev server renders, for the excerpt of a section. */
export const devPageUrl = "/@vaporpress/page";

/** One section of a page: the content under one heading. */
export interface SearchSection {
  /** The URL of the section: the URL of the page, and the id of its heading after `#`. */
  readonly id: string;
  readonly title: string;
  /** The titles of the headings above the section. */
  readonly titles: readonly string[];
  readonly text: string;
}

export const searchIndexOptions = {
  fields: ["title", "titles", "text"],
  storeFields: ["title", "titles"],
  searchOptions: { fuzzy: 0.2, prefix: true, boost: { title: 4, text: 2, titles: 1 } },
} as const satisfies Options<SearchSection>;
