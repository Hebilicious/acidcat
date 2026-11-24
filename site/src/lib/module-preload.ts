import { readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { AstroIntegration } from "astro";

/** Each module of the client build, and the modules that it imports statically. */
export type ModuleGraph = ReadonlyMap<string, readonly string[]>;

const scriptSource = /<script type="module" src="\/([^"]+)"/g;

/** The module scripts of a page and every module that they import statically, in the order that the page needs them. */
export const pageModules = (html: string, graph: ModuleGraph): string[] => {
  const modules = new Set<string>();
  const visit = (file: string) => {
    if (modules.has(file)) return;
    modules.add(file);
    for (const imported of graph.get(file) ?? []) visit(imported);
  };
  for (const [, file] of html.matchAll(scriptSource)) if (file !== undefined) visit(file);
  return [...modules];
};

const head = /<head(?:\s[^>]*)?>/;

/**
 * Adds a `modulepreload` link for each module that the page loads at once. The links come first in the head, before
 * any script, so that the browser fetches each module once, from the link.
 */
export const preloadModules = (html: string, graph: ModuleGraph): string => {
  const links = pageModules(html, graph)
    .map((file) => `<link rel="modulepreload" href="/${file}">`)
    .join("");
  if (links === "") return html;
  return html.replace(head, (tag) => `${tag}${links}`);
};

/**
 * Preloads every module that a page loads at once. The browser then fetches the static imports of a script together
 * with the script, and not after it.
 */
export const modulePreload = (): AstroIntegration => {
  const graph = new Map<string, readonly string[]>();
  return {
    name: "acidcat-module-preload",
    hooks: {
      "astro:config:setup": ({ updateConfig }) => {
        updateConfig({
          vite: {
            plugins: [
              {
                name: "acidcat-module-graph",
                generateBundle(_options, bundle) {
                  for (const output of Object.values(bundle)) if (output.type === "chunk") graph.set(output.fileName, output.imports);
                },
              },
            ],
          },
        });
      },
      "astro:build:done": async ({ dir }) => {
        const root = fileURLToPath(dir);
        const entries = await readdir(root, { withFileTypes: true, recursive: true });
        for (const entry of entries) {
          if (!entry.isFile() || !entry.name.endsWith(".html")) continue;
          const path = join(entry.parentPath, entry.name);
          const html = await readFile(path, "utf8");
          const preloaded = preloadModules(html, graph);
          if (preloaded !== html) await writeFile(path, preloaded);
        }
      },
    },
  };
};
