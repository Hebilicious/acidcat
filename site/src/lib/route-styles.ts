import { createHash } from "node:crypto";
import { readdir, readFile, rm, writeFile } from "node:fs/promises";
import { join, relative, sep } from "node:path";
import type { ChildNode, Plugin } from "postcss";
import { isRoute, routeOfPage, routes } from "./routes.ts";
import type { Route } from "./routes.ts";


const sources: readonly (readonly [RegExp, Route])[] = [
  [/\/site\/src\/styles\/(docs|content|explorer|diagrams)\.css$/, "docs"],
  [/\/site\/src\/components\/PackagesPage\.vue$/, "docs"],
  [/\/site\/src\/app\/SearchDialog\.vue$/, "docs"],
  [/\/site\/content\/index\.vue$/, "home"],
  [/\/site\/src\/styles\/home\.css$/, "home"],
  [/\/site\/src\/components\/[^/]+\.vue$/, "home"],
];

export const routeOfSource = (file: string): Route | undefined => {
  const path = file.split("?")[0]?.split(sep).join("/") ?? "";
  return sources.find(([pattern]) => pattern.test(path))?.[1];
};

const marker = (route: Route): string => `(--acidcat-route: ${route})`;
const markerPattern = /^@supports\s*\(--acidcat-route:\s*(\w+)\)\s*\{/;

/**
 * Wraps the CSS of each route in `@supports (--acidcat-route: <route>)`. Every browser that reads custom properties
 * passes this condition, so the wrapper changes nothing on the page. It survives the minifier, so the build can split
 * the one stylesheet of the build by route.
 */
export const markRoutes = (): Plugin => ({
  postcssPlugin: "acidcat-route-styles",
  Once: (root, { AtRule }) => {
    root.each((node) => {
      const route = routeOfSource(node.source?.input.file ?? "");
      if (route === undefined) return;
      const previous: ChildNode | undefined = node.prev();
      if (previous?.type === "atrule" && previous.name === "supports" && previous.params === marker(route)) {
        previous.append(node);
        return;
      }
      const wrapper = new AtRule({ name: "supports", params: marker(route) });
      node.before(wrapper);
      wrapper.append(node);
    });
  },
});

interface Segment {
  readonly route: Route | "shared";
  readonly css: string;
}

const blockEnd = (css: string, open: number): number => {
  let depth = 0;
  let quote: string | undefined;
  for (let index = open; index < css.length; index += 1) {
    const character = css[index];
    if (quote !== undefined) {
      if (character === "\\") index += 1;
      else if (character === quote) quote = undefined;
    } else if (character === '"' || character === "'") quote = character;
    else if (character === "{") depth += 1;
    else if (character === "}" && --depth === 0) return index;
  }
  throw new Error("A route block of the stylesheet has no end.");
};

export const splitRoutes = (css: string): Segment[] => {
  const segments: Segment[] = [];
  let shared = 0;
  for (let start = css.indexOf("@supports"); start !== -1; start = css.indexOf("@supports", start + 1)) {
    const match = markerPattern.exec(css.slice(start));
    const route = match?.[1];
    if (match === null || !isRoute(route)) continue;
    const open = start + match[0].length - 1;
    const end = blockEnd(css, open);
    segments.push({ route: "shared", css: css.slice(shared, start) }, { route, css: css.slice(open + 1, end) });
    shared = end + 1;
    start = end;
  }
  segments.push({ route: "shared", css: css.slice(shared) });
  return segments.filter((segment) => segment.css !== "");
};

const stylesheetLink = /<link rel="(?:preload )?stylesheet" href="(\/assets\/[^"]+\.css)"[^>]*>/g;
const pick = (segments: readonly Segment[], keep: (route: Segment["route"]) => boolean): string =>
  segments
    .filter((segment) => keep(segment.route))
    .map((segment) => segment.css)
    .join("");

const pagePath = (dist: string, file: string): string => `/${relative(dist, file).split(sep).join("/")}`.replace(/index\.html$/, "").replace(/\.html$/, "/");

export const inlineStyles = async (dist: string): Promise<void> => {
  const entries = await readdir(dist, { withFileTypes: true, recursive: true });
  const pages = entries.filter((entry) => entry.isFile() && entry.name.endsWith(".html")).map((entry) => join(entry.parentPath, entry.name));
  const sheets = new Map<string, Segment[]>();
  for (const page of pages) {
    for (const [, href = ""] of (await readFile(page, "utf8")).matchAll(stylesheetLink)) {
      if (!sheets.has(href)) sheets.set(href, splitRoutes(await readFile(join(dist, href), "utf8")));
    }
  }
  if (sheets.size === 0) throw new Error("No page links a stylesheet. Change site/src/lib/route-styles.ts to match the HTML of the build.");
  const segments = [...sheets.values()].flat();
  const files: Partial<Record<Route, string>> = {};
  for (const route of routes) {
    const css = pick(segments, (candidate) => candidate === route);
    if (css === "") continue;
    const href = `/assets/${route}.${createHash("sha256").update(css).digest("base64url").slice(0, 8)}.css`;
    await writeFile(join(dist, href), css);
    files[route] = href;
  }
  const index = `<script type="application/json" id="route-styles">${JSON.stringify(files)}</script>`;
  await Promise.all(
    pages.map(async (page) => {
      const route = routeOfPage(pagePath(dist, page));
      const html = await readFile(page, "utf8");
      const hrefs = [...html.matchAll(stylesheetLink)].map((match) => match[1] ?? "");
      if (hrefs.length === 0) throw new Error(`${page} links no stylesheet. Change site/src/lib/route-styles.ts to match the HTML of the build.`);
      const css = pick(
        hrefs.flatMap((href) => sheets.get(href) ?? []),
        (candidate) => candidate === "shared" || candidate === route,
      );
      let first = true;
      const inlined = html.replace(stylesheetLink, () => {
        if (!first) return "";
        first = false;
        return `<style data-route="${route}">${css}</style>${index}`;
      });
      await writeFile(page, inlined);
    }),
  );
  await Promise.all([...sheets.keys()].map((href) => rm(join(dist, href))));
};
