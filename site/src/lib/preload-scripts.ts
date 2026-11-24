import { readFile } from "node:fs/promises";
import { join, posix } from "node:path";

const moduleScript = /<script type="module" src="([^"]+)"><\/script>/g;
const modulePreload = /<link rel="modulepreload" href="([^"]+)">/g;
const staticImport = /(?:^|[;}\n])\s*import\s*(?:[^"'`()]*?from\s*)?"(\.{1,2}\/[^"]+\.js)"/g;

const imports = new Map<string, Promise<readonly string[]>>();

/** The scripts that the script at `href` imports statically, as paths from the root of the site. */
const staticImports = (dist: string, href: string): Promise<readonly string[]> => {
  let found = imports.get(href);
  if (found === undefined) {
    found = readFile(join(dist, href), "utf8").then((code) => [...code.matchAll(staticImport)].map(([, path = ""]) => posix.join(posix.dirname(href), path)));
    imports.set(href, found);
  }
  return found;
};

/**
 * Names each module script of the head as a `modulepreload` link, and each script that those scripts import
 * statically, at any depth. The browser fetches every script of the page at once, and Lighthouse counts no preload in a
 * chain of critical requests, so the page passes the audit "Network dependency tree".
 */
export const preloadModuleScripts = async (html: string, dist: string): Promise<string> => {
  const end = html.indexOf("</head>");
  const head = html.slice(0, end).replace(moduleScript, (script, src: string) => `<link rel="modulepreload" href="${src}">${script}`);
  const named = [...head.matchAll(modulePreload)].map(([, href = ""]) => href);
  const all = new Set(named);
  for (const href of all) for (const imported of await staticImports(dist, href)) all.add(imported);
  const missing = [...all].filter((href) => !named.includes(href)).map((href) => `<link rel="modulepreload" href="${href}">`);
  return head + missing.join("") + html.slice(end);
};
