import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import { pathToFileURL } from "node:url";
import { leanPageChunkMarker } from "./client/markers.ts";
import type { PageData } from "./page.ts";
import { searchIndexJson, searchMeta, writeSearchIndex } from "./search-index.ts";

export interface DocumentOptions {
  /** The language of every page. */
  readonly lang?: string;
  /** HTML for the head of every page, such as the icon and the theme color. */
  readonly headHtml?: string;
  /** Changes the HTML of each page after the render, before it is written. */
  readonly transformHtml?: (html: string, page: PageData, build: BuildFiles) => string | Promise<string>;
}

export interface BuildFiles {
  readonly files: readonly string[];
}

interface ManifestChunk {
  readonly file: string;
  readonly name?: string;
  readonly src?: string;
  readonly isEntry?: boolean;
  readonly imports?: readonly string[];
  readonly css?: readonly string[];
}

type Manifest = Readonly<Record<string, ManifestChunk>>;

interface ServerEntry {
  readonly paths: () => readonly string[];
  readonly render: (path: string) => Promise<{ readonly html: string; readonly head: string; readonly page: PageData }>;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);
const isStringList = (value: unknown): value is readonly string[] => Array.isArray(value) && value.every((item) => typeof item === "string");
const optional = (value: unknown, check: (value: unknown) => boolean): boolean => value === undefined || check(value);

const isManifestChunk = (value: unknown): value is ManifestChunk =>
  isRecord(value) &&
  typeof value["file"] === "string" &&
  optional(value["name"], (name) => typeof name === "string") &&
  optional(value["src"], (src) => typeof src === "string") &&
  optional(value["isEntry"], (entry) => typeof entry === "boolean") &&
  optional(value["imports"], isStringList) &&
  optional(value["css"], isStringList);

const isManifest = (value: unknown): value is Manifest => isRecord(value) && Object.values(value).every((chunk) => isManifestChunk(chunk));

const isServerEntry = (value: unknown): value is ServerEntry => isRecord(value) && typeof value["paths"] === "function" && typeof value["render"] === "function";

const readManifest = async (outDir: string): Promise<Manifest> => {
  const manifest: unknown = JSON.parse(await readFile(join(outDir, ".vite/manifest.json"), "utf8"));
  if (!isManifest(manifest)) throw new Error("The Vite manifest of the client build has an unknown shape.");
  return manifest;
};

const collect = (manifest: Manifest, key: string, scripts: Set<string>, styles: Set<string>): void => {
  const chunk = manifest[key];
  if (chunk === undefined || scripts.has(chunk.file)) return;
  scripts.add(chunk.file);
  for (const file of chunk.css ?? []) styles.add(file);
  for (const imported of chunk.imports ?? []) collect(manifest, imported, scripts, styles);
};

export const pageUrl = (path: string): string => (path === "/" || path === "/404" ? path : `${path}/`);

export const outputFile = (outDir: string, path: string): string => {
  if (path === "/404") return join(outDir, "404.html");
  return join(outDir, path, "index.html");
};

export interface PrerenderInput {
  readonly root: string;
  readonly outDir: string;
  readonly serverEntry: string;
  readonly routeFiles: ReadonlyMap<string, string>;
  readonly options: DocumentOptions;
  readonly clientEntryName: string;
  /** Writes the search index of the pages, and names it in the head of each page. */
  readonly search: boolean;
  readonly assetsDir: string;
}

export const prerender = async (input: PrerenderInput): Promise<void> => {
  const manifest = await readManifest(input.outDir);
  const entryKey = Object.entries(manifest).find(([, chunk]) => chunk.isEntry === true && chunk.name === input.clientEntryName)?.[0];
  if (entryKey === undefined) throw new Error("The manifest has no entry chunk for the client.");
  const server: unknown = await import(pathToFileURL(input.serverEntry).href);
  if (!isServerEntry(server)) throw new Error("The server build does not export paths and render.");
  const base = "/";
  const entries = await readdir(input.outDir, { withFileTypes: true, recursive: true });
  const files = entries.filter((entry) => entry.isFile()).map((entry) => relative(input.outDir, join(entry.parentPath, entry.name)));
  const build: BuildFiles = { files: files.filter((file) => !file.startsWith(".vite/")).map((file) => `${base}${file}`) };
  const written: { readonly path: string; readonly html: string }[] = [];
  for (const path of server.paths()) {
    const { html, head, page } = await server.render(pageUrl(path));
    const scripts = new Set<string>();
    const styles = new Set<string>();
    collect(manifest, entryKey, scripts, styles);
    const file = input.routeFiles.get(path);
    const leanKey = file === undefined ? undefined : `${file}?lean`;
    const lean = leanKey === undefined ? undefined : manifest[leanKey];
    if (leanKey !== undefined) collect(manifest, leanKey, scripts, styles);
    const entryFile = manifest[entryKey]?.file;
    const links = [
      ...[...styles].map((style) => `<link rel="stylesheet" href="${base}${style}">`),
      ...[...scripts]
        .filter((script) => script !== entryFile)
        .map((script) => `<link rel="modulepreload" href="${base}${script}"${script === lean?.file ? ` ${leanPageChunkMarker}` : ""}>`),
    ];
    const document = [
      "<!doctype html>",
      `<html lang="${input.options.lang ?? "en"}">`,
      '<head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">',
      head,
      input.options.headHtml ?? "",
      ...links,
      `<script type="module" src="${base}${entryFile ?? ""}"></script>`,
      `</head><body><div id="app">${html}</div></body></html>`,
    ].join("");
    written.push({ path, html: input.options.transformHtml === undefined ? document : await input.options.transformHtml(document, page, build) });
  }
  const meta = input.search ? searchMeta(await writeSearchIndex(input.outDir, input.assetsDir, searchIndexJson(written.map((page) => ({ url: pageUrl(page.path), html: page.html }))))) : "";
  for (const page of written) {
    const output = outputFile(input.outDir, page.path);
    await mkdir(dirname(output), { recursive: true });
    await writeFile(output, meta === "" ? page.html : page.html.replace("</head>", `${meta}</head>`));
  }
};
