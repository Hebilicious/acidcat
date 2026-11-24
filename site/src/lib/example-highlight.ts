import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRoot } from "./ecosystem.ts";
import { fileKind, sourcePath } from "./example-files.ts";
import { highlight } from "./highlight.ts";

export const highlightExampleFile = async (example: string, file: string, repository = repositoryRoot): Promise<string> => {
  const code = await readFile(join(repository, sourcePath(example, file)), "utf8");
  return highlight(code.replace(/\n$/, ""), fileKind(file).lang);
};

const escapeAttribute = (text: string): string => text.replaceAll("&", "&amp;").replaceAll('"', "&quot;");
const unescapeAttribute = (text: string): string => text.replaceAll("&quot;", '"').replaceAll("&amp;", "&");
const placeholder = /<div class="source" data-source data-example="([^"]+)" data-file="([^"]+)" aria-busy="false"><\/div>/g;

/**
 * The source pane of a code explorer, empty. The page chunk keeps the static HTML of a page for the page changes in
 * the browser, so the highlighted file would weigh on each prefetch of the page. `writeExplorerSources` writes the file
 * into the built HTML, and after a page change in the browser the explorer loads it as a fragment.
 */
export const explorerSource = (example: string, file: string): string =>
  `<div class="source" data-source data-example="${escapeAttribute(example)}" data-file="${escapeAttribute(file)}" aria-busy="false"></div>`;

export const writeExplorerSources = async (html: string, repository = repositoryRoot): Promise<string> => {
  const sources = await Promise.all([...html.matchAll(placeholder)].map(([, example = "", file = ""]) => highlightExampleFile(unescapeAttribute(example), unescapeAttribute(file), repository)));
  let index = 0;
  return html.replace(placeholder, () => `<div class="source" data-source aria-busy="false">${sources[index++] ?? ""}</div>`);
};
