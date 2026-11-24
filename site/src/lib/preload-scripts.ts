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

const starter = (sources: readonly string[]): string => {
  const imports = sources.reduce((chain, src) => `${chain}.then(()=>import(${JSON.stringify(src)}))`, "Promise.resolve()");
  return [
    "<script>{",
    "let started=false;",
    `const start=()=>{if(started)return;started=true;${imports}};`,
    "const afterPaint=()=>{",
    'if(document.visibilityState!=="visible"||!PerformanceObserver.supportedEntryTypes.includes("paint"))return start();',
    'new PerformanceObserver((_,observer)=>{observer.disconnect();start()}).observe({type:"paint",buffered:true});',
    'addEventListener("load",start,{once:true})',
    "};",
    'document.readyState==="loading"?addEventListener("DOMContentLoaded",afterPaint,{once:true}):afterPaint()',
    "}</script>",
  ].join("");
};

/**
 * Fetches the scripts of a page with its HTML, and starts them after the first paint.
 *
 * - Each module script and `modulepreload` link of the head, and each script that they import statically at any depth,
 *   becomes a `preload` link. The browser fetches each script at once, and compiles it only when the page imports it.
 *   Lighthouse counts no preload in a chain of critical requests, so the page passes the audit "Network dependency
 *   tree".
 * - One inline script imports the module scripts in their order when the document is parsed and the browser reports
 *   its first paint, so the browser paints the page from the server before it evaluates the scripts and hydrates the
 *   page. A hidden page does not paint, so it imports them when the document is parsed, as does a browser that does
 *   not report paints. A page that has nothing to paint before its scripts run, such as the 404 page of VitePress,
 *   imports them at the load event.
 */
export const startScriptsAfterFirstPaint = async (html: string, dist: string): Promise<string> => {
  const end = html.indexOf("</head>");
  const head = html.slice(0, end);
  const sources = [...head.matchAll(moduleScript)].map(([, src = ""]) => src);
  if (sources.length === 0) return html;
  const scripts = new Set([...sources, ...[...head.matchAll(modulePreload)].map(([, href = ""]) => href)]);
  for (const href of scripts) for (const imported of await staticImports(dist, href)) scripts.add(imported);
  const preloads = [...scripts].map((href) => `<link rel="preload" as="script" crossorigin href="${href}">`).join("");
  let first = true;
  const rewritten = head.replace(modulePreload, "").replace(moduleScript, () => {
    const replacement = first ? preloads + starter(sources) : "";
    first = false;
    return replacement;
  });
  return rewritten + html.slice(end);
};
