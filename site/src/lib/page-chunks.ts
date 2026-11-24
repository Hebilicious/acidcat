import { basename } from "node:path";
import type { Plugin } from "vite";

interface ModuleGraph {
  getModuleInfo(id: string): { readonly importers: readonly string[]; readonly importedIds: readonly string[]; readonly dynamicallyImportedIds: readonly string[] } | null;
}

const isPage = (id: string) => id.endsWith(".md");

const walk = (start: string, next: (id: string) => readonly string[]): Set<string> => {
  const seen = new Set([start]);
  for (const id of seen) for (const other of next(id)) seen.add(other);
  return seen;
};

/** The pages that import `id` statically, and `""` when an entry that is not a page, such as the theme, imports it. */
const importingPages = (graph: ModuleGraph, id: string): Set<string> => {
  const importers = (module: string) => (isPage(module) ? [] : (graph.getModuleInfo(module)?.importers ?? []));
  const reached = [...walk(id, importers)];
  const pages = reached.filter(isPage);
  const fromEntry = reached.some((module) => !isPage(module) && (graph.getModuleInfo(module)?.importers.length ?? 0) === 0);
  return new Set(fromEntry ? [...pages, ""] : pages);
};

const importsDynamically = (graph: ModuleGraph, page: string): boolean =>
  [...walk(page, (module) => graph.getModuleInfo(module)?.importedIds ?? [])].some((module) => (graph.getModuleInfo(module)?.dynamicallyImportedIds.length ?? 0) > 0);

/**
 * Puts the modules that only one page imports in a chunk of their own, when that page also imports a module
 * dynamically.
 *
 * VitePress copies the chunk of each page into a `.lean.js` file, and the browser starts the page from the copy. A
 * module that stays in the chunk of the page, and that a dynamic import of the page also uses, then runs a second time
 * from the full chunk, which the browser downloads for it. In a chunk of its own, the module runs once.
 */
export const pageModuleChunks = (): Plugin => {
  const names = new Map<string, string | undefined>();
  const dynamicPages = new Map<string, boolean>();
  const chunkName = (id: string, graph: ModuleGraph): string | undefined => {
    if (isPage(id) || id.startsWith("\0") || id.includes("/node_modules/")) return undefined;
    if (names.has(id)) return names.get(id);
    const [page, ...others] = importingPages(graph, id);
    let dynamic = page === undefined || page === "" ? false : dynamicPages.get(page);
    if (dynamic === undefined && page !== undefined) dynamicPages.set(page, (dynamic = importsDynamically(graph, page)));
    const name = page !== undefined && others.length === 0 && dynamic === true ? `${basename(page, ".md")}-modules` : undefined;
    names.set(id, name);
    return name;
  };
  return {
    name: "acidcat-page-module-chunks",
    apply: "build",
    applyToEnvironment: (environment) => environment.name === "client",
    outputOptions(options) {
      const splitting = typeof options.codeSplitting === "object" ? options.codeSplitting : {};
      return { ...options, codeSplitting: { ...splitting, groups: [...(splitting.groups ?? []), { name: chunkName }] } };
    },
  };
};
