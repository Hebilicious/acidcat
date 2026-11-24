import { appendFile, mkdir, readFile, stat, writeFile } from "node:fs/promises";
import { createServer } from "node:http";
import type { AddressInfo } from "node:net";
import { extname, join, normalize } from "node:path";
import { parseArgs } from "node:util";
import { brotliCompressSync } from "node:zlib";
import lighthouse from "lighthouse";
import type { Result } from "lighthouse";
import { chromium } from "playwright";

const { values } = parseArgs({ options: { runs: { type: "string", default: "5" }, out: { type: "string", default: ".tmp/lighthouse" } } });
const runs = Number(values.runs);
const out = values.out;
const dist = new URL("../dist/", import.meta.url).pathname;
const pages = { home: "/", "quick-start": "/docs/quick-start/" } as const;

/** Audits that pass or fail, with no score in between. Each run of each page must pass them. */
const gatedAudits = ["network-dependency-tree-insight", "forced-reflow-insight", "image-delivery-insight", "render-blocking-insight", "cls-culprits-insight", "cumulative-layout-shift", "agent-accessibility-tree"];

/** The lowest median score of each category. See "Lighthouse" in the README for the spread that each number allows. */
const categoryBudgets: Readonly<Record<keyof typeof pages, Readonly<Record<string, number>>>> = {
  home: { performance: 70, accessibility: 100, "best-practices": 100, seo: 100 },
  "quick-start": { performance: 90, accessibility: 100, "best-practices": 100, seo: 100 },
};

const types: Readonly<Record<string, string>> = {
  ".html": "text/html; charset=utf-8",
  ".css": "text/css",
  ".js": "text/javascript",
  ".json": "application/json",
  ".svg": "image/svg+xml",
  ".woff2": "font/woff2",
  ".webp": "image/webp",
  ".avif": "image/avif",
  ".png": "image/png",
  ".jpg": "image/jpeg",
  ".txt": "text/plain; charset=utf-8",
  ".md": "text/markdown; charset=utf-8",
  ".xml": "application/xml",
};
const compressible = new Set([".html", ".css", ".js", ".json", ".svg", ".txt", ".md", ".xml"]);

const resolveFile = async (pathname: string): Promise<string | undefined> => {
  const path = normalize(join(dist, decodeURIComponent(pathname)));
  if (!path.startsWith(dist)) return undefined;
  const info = await stat(path).catch(() => undefined);
  if (info?.isDirectory() === true) return join(path, "index.html");
  return info === undefined ? undefined : path;
};

/** Serves `dist/` as the Worker does for these pages: Brotli for text, and the cache headers of `public/_headers`. */
const serve = async (): Promise<{ origin: string; close: () => Promise<void> }> => {
  const server = createServer((request, response) => {
    const { pathname } = new URL(request.url ?? "/", "http://site");
    void resolveFile(pathname).then(async (found) => {
      const path = found ?? join(dist, "404.html");
      const extension = extname(path);
      const body = await readFile(path);
      const brotli = compressible.has(extension) && (request.headers["accept-encoding"] ?? "").includes("br");
      response.writeHead(found === undefined ? 404 : 200, {
        "Content-Type": types[extension] ?? "application/octet-stream",
        "Cache-Control": pathname.startsWith("/assets/") ? "public, max-age=31536000, immutable" : "public, max-age=0, must-revalidate",
        ...(brotli ? { "Content-Encoding": "br", Vary: "Accept-Encoding" } : {}),
      });
      response.end(brotli ? brotliCompressSync(body) : body);
    });
  });
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  if (address === null || typeof address === "string") throw new Error("The server has no port.");
  return { origin: `http://localhost:${address.port}`, close: () => new Promise((resolve) => server.close(() => resolve())) };
};

const freePort = async (): Promise<number> => {
  const server = createServer();
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve));
  const address: AddressInfo | string | null = server.address();
  await new Promise<void>((resolve) => server.close(() => resolve()));
  if (address === null || typeof address === "string") throw new Error("No free port.");
  return address.port;
};

const passes = (audit: Result["audits"][string] | undefined): boolean =>
  audit !== undefined && (audit.score === null ? audit.scoreDisplayMode === "notApplicable" : audit.score >= 0.9);

const median = (numbers: readonly number[]): number => {
  const sorted = [...numbers].sort((a, b) => a - b);
  return sorted[Math.floor(sorted.length / 2)] ?? Number.NaN;
};

const score = (result: Result, category: string): number => Math.round((result.categories[category]?.score ?? 0) * 100);

const server = await serve();
const port = await freePort();
const browser = await chromium.launch({ args: [`--remote-debugging-port=${port}`] });
await mkdir(out, { recursive: true });

const summary: string[] = [];
let version = "";
const failures: string[] = [];
try {
  for (const name of Object.keys(categoryBudgets).filter((key): key is keyof typeof pages => key in pages)) {
    const path = pages[name];
    const results: Result[] = [];
    for (let run = 1; run <= runs; run += 1) {
      const runner = await lighthouse(`${server.origin}${path}`, { port, output: ["html", "json"], logLevel: "error", blockedUrlPatterns: ["https://api.github.com/*"] });
      if (runner === undefined) throw new Error(`Lighthouse gave no result for ${path}.`);
      const [html = "", json = ""] = Array.isArray(runner.report) ? runner.report : [runner.report];
      await writeFile(join(out, `${name}-${run}.report.html`), html);
      await writeFile(join(out, `${name}-${run}.report.json`), json);
      results.push(runner.lhr);
    }
    version = results[0]?.lighthouseVersion ?? "";
    summary.push(`### ${name} (${path}), ${runs} runs`, "", "| Category | Median | Runs | Budget |", "| --- | --- | --- | --- |");
    for (const [category, minimum] of Object.entries(categoryBudgets[name])) {
      const scores = results.map((result) => score(result, category));
      const middle = median(scores);
      summary.push(`| ${category} | ${middle} | ${scores.join(", ")} | ≥ ${minimum} |`);
      if (middle < minimum) failures.push(`${path}: ${category} has a median of ${middle}, under ${minimum}.`);
    }
    summary.push("", "| Audit | Passed runs |", "| --- | --- |");
    for (const id of gatedAudits) {
      const passed = results.filter((result) => passes(result.audits[id])).length;
      summary.push(`| ${id} | ${passed} of ${runs} |`);
      if (passed < runs) failures.push(`${path}: the audit ${id} fails in ${runs - passed} of ${runs} runs.`);
    }
    summary.push("");
  }
} finally {
  await browser.close();
  await server.close();
}

summary.push(failures.length === 0 ? "Every budget holds." : `**Failures**\n\n${failures.map((failure) => `- ${failure}`).join("\n")}`, "");
const text = `## Lighthouse ${version}, mobile\n\n${summary.join("\n")}`;
await writeFile(join(out, "summary.md"), text);
const stepSummary = process.env["GITHUB_STEP_SUMMARY"];
if (stepSummary !== undefined) await appendFile(stepSummary, text);
console.log(text);
if (failures.length > 0) process.exitCode = 1;
