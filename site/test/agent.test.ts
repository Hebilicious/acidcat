import assert from "node:assert/strict";
import { createHash } from "node:crypto";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { after, before, test } from "node:test";
import { gunzipSync } from "node:zlib";
import { renderCatalog } from "@acid-cat/core-ts";
import { serve } from "@acid-cat/core-ts/node";
import type { Served } from "@acid-cat/core-ts/node";
import { Client, StreamableHTTPClientTransport } from "@modelcontextprotocol/client";
import { chromium } from "playwright";
import { site, toJsonSchema } from "../src/lib/agent/app.ts";
import { siteContext, SiteContent } from "../src/lib/agent/content.ts";
import { catalogPath } from "../src/lib/agent/write-catalog.ts";
import { handle, siteHandlers } from "../worker/index.ts";
import { builtPages, dist, serveDist } from "./static-server.ts";
import type { StaticServer } from "./static-server.ts";

let assets: StaticServer | undefined;
let worker: Served | undefined;
let origin = "";

before(async () => {
  const files = await serveDist();
  assets = files;
  const fromDist = (request: Request): Promise<Response> => {
    const url = new URL(request.url);
    return fetch(`${files.origin}${url.pathname}`, { method: request.method });
  };
  const context = siteContext((path) => fromDist(new Request(new URL(path, files.origin))));
  worker = await serve(handle(siteHandlers(context), { fetch: fromDist }), { port: 0 });
  origin = worker.url;
});

after(async () => {
  await worker?.close();
  await assets?.close();
});

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const getJson = async (path: string): Promise<{ response: Response; body: Record<string, unknown> }> => {
  const response = await fetch(`${origin}${path}`);
  const body: unknown = await response.json();
  if (!isRecord(body)) throw new Error(`${path} is not a JSON object.`);
  return { response, body };
};

test("the catalog of the site is the catalog that its code writes", async () => {
  assert.equal(await readFile(catalogPath, "utf8"), renderCatalog(site, { toJsonSchema }));
});

test("each page has a Markdown version, and the content of the app lists each page", async () => {
  const content = SiteContent.parse(JSON.parse(await readFile(join(dist, "content.json"), "utf8")));
  const pages = (await builtPages()).filter((file) => !file.endsWith("404.html"));
  assert.equal(content.pages.length, pages.length);
  for (const file of pages) {
    const markdown = await readFile(file.replace(/index\.html$/, "index.md"), "utf8");
    assert.match(markdown, /^# \S/, `${file} has a Markdown version with a title`);
  }
  const tabs = content.pages.find((page) => page.path === "/docs/quick-start/")?.markdown ?? "";
  for (const language of ["**TypeScript**", "**Python**", "**Go**", "**Rust**", "**Pkl**"]) assert.ok(tabs.includes(language), `the Markdown of a page keeps the tab ${language}`);
  const llms = await readFile(join(dist, "llms.txt"), "utf8");
  assert.match(llms, /^# AcidCat\n/);
  for (const page of content.pages.filter((entry) => entry.section !== "home")) assert.ok(llms.includes(`${page.path}index.md)`), `llms.txt links ${page.path}`);
});

test("the agent skills index gives the digest of each archive, and the archive holds the skill of the repository", async () => {
  const index: unknown = JSON.parse(await readFile(join(dist, ".well-known/agent-skills/index.json"), "utf8"));
  assert.ok(isRecord(index) && Array.isArray(index["skills"]));
  const skill: unknown = index["skills"][0];
  assert.ok(isRecord(skill) && typeof skill["url"] === "string");
  const archive = await readFile(join(dist, skill["url"]));
  assert.equal(skill["digest"], `sha256:${createHash("sha256").update(archive).digest("hex")}`);
  const tar = gunzipSync(archive);
  assert.equal(tar.subarray(0, 8).toString("ascii"), "SKILL.md");
  const expected = await readFile(new URL("../../skills/acid-cat/SKILL.md", import.meta.url));
  assert.deepEqual(tar.subarray(512, 512 + expected.length), expected);
});

test("a page answers with Markdown to a client that prefers it, and with HTML and links to a browser", async () => {
  const markdown = await fetch(`${origin}/docs/quick-start/`, { headers: { Accept: "text/markdown" } });
  assert.equal(markdown.headers.get("Content-Type"), "text/markdown; charset=utf-8");
  assert.equal(markdown.headers.get("Vary"), "Accept");
  assert.match(await markdown.text(), /^# Quick start\n/);

  const html = await fetch(`${origin}/`, { headers: { Accept: "text/html,application/xhtml+xml,*/*;q=0.8" } });
  assert.equal(html.headers.get("Content-Type"), "text/html");
  assert.equal(html.headers.get("Vary"), "Accept");
  const links = html.headers.get("Link") ?? "";
  for (const relation of ['rel="api-catalog"', 'rel="service-desc"', 'rel="service-doc"', 'rel="describedby"', '</index.md>; rel="alternate"; type="text/markdown"']) {
    assert.ok(links.includes(relation), `the Link header has ${relation}`);
  }
});

test("the well-known documents point at the MCP server and the HTTP API of the site", async () => {
  const catalog = await getJson("/.well-known/api-catalog");
  assert.equal(catalog.response.headers.get("Content-Type"), "application/linkset+json");
  assert.deepEqual(
    Array.isArray(catalog.body["linkset"]) ? catalog.body["linkset"].map((entry: unknown) => (isRecord(entry) ? entry["anchor"] : undefined)) : [],
    [`${origin}/api`, `${origin}/mcp`],
  );

  const ai = await getJson("/.well-known/ai-catalog.json");
  assert.equal(ai.response.headers.get("Access-Control-Allow-Origin"), "*");
  const entries = Array.isArray(ai.body["entries"]) ? ai.body["entries"] : [];
  assert.ok(entries.length > 0 && entries.every((entry: unknown) => isRecord(entry) && ("url" in entry) !== ("data" in entry)), "each entry has exactly one of url and data");

  const wellKnown = await getJson("/.well-known/mcp/server-card.json");
  const card = await getJson("/mcp/server-card");
  assert.deepEqual(wellKnown.body, card.body);
});

test("an MCP client lists and calls the tools of the site", async () => {
  const client = new Client({ name: "site-test", version: "0.0.0" });
  await client.connect(new StreamableHTTPClientTransport(new URL(`${origin}/mcp`)));
  const { tools } = await client.listTools();
  assert.deepEqual(tools.map((tool) => tool.name).sort(), ["site.packages.list", "site.pages.list", "site.pages.read", "site.pages.search"]);
  assert.ok(tools.every((tool) => tool.annotations?.readOnlyHint === true));

  const found = await client.callTool({ name: "site.pages.search", arguments: { query: "server card", limit: 3 } });
  assert.match(JSON.stringify(found.structuredContent), /\/spec\/bindings\/mcp\//);
  const missing = await client.callTool({ name: "site.pages.read", arguments: { path: "/no/such/page/" } });
  assert.equal(missing.isError, true);
  await client.close();
});

test("the HTTP API reads a page", async () => {
  const response = await fetch(`${origin}/api/capabilities/site.pages.read`, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ path: "/spec/catalog/" }) });
  const outcome: unknown = await response.json();
  assert.ok(isRecord(outcome) && outcome["ok"] === true && isRecord(outcome["value"]));
  assert.equal(outcome["value"]["title"], "Catalog");
});

test("a browser with WebMCP gets the tools of the site when the page loads, and a browser without it loads none of their code", async () => {
  if (assets === undefined) throw new Error("No server.");
  const browser = await chromium.launch({ args: ["--enable-features=WebMCP"] });
  const page = await browser.newPage();
  const scripts = (target: typeof page): string[] => {
    const loaded: string[] = [];
    target.on("request", (request) => {
      if (request.resourceType() === "script") loaded.push(new URL(request.url()).pathname);
    });
    return loaded;
  };
  const withTools = scripts(page);
  await page.goto(`${assets.origin}/docs/`, { waitUntil: "networkidle" });
  const tools = await page.evaluate(async () => {
    const host: unknown = Reflect.get(document, "modelContext");
    if (typeof host !== "object" || host === null) return { names: [], result: "" };
    const getTools: unknown = Reflect.get(host, "getTools");
    const executeTool: unknown = Reflect.get(host, "executeTool");
    if (typeof getTools !== "function" || typeof executeTool !== "function") return { names: [], result: "" };
    const all: unknown = await Reflect.apply(getTools, host, []);
    if (!Array.isArray(all)) return { names: [], result: "" };
    const search: unknown = all.find((tool: unknown) => Reflect.get(Object(tool), "name") === "site.pages.search");
    const result: unknown = await Reflect.apply(executeTool, host, [search, { query: "WebMCP" }]);
    return { names: all.map((tool: unknown) => String(Reflect.get(Object(tool), "name"))).sort(), result: String(result) };
  });
  assert.deepEqual(tools.names, ["site.packages.list", "site.pages.list", "site.pages.read", "site.pages.search"]);
  assert.match(tools.result, /"ok":true/);
  await browser.close();

  const plain = await chromium.launch();
  const without = await plain.newPage();
  const withoutTools = scripts(without);
  await without.goto(`${assets.origin}/docs/`, { waitUntil: "networkidle" });
  assert.equal(await without.evaluate(() => "modelContext" in document || "modelContext" in navigator), false);
  const toolCode = withTools.filter((path) => !withoutTools.includes(path));
  assert.ok(toolCode.length > 0, "the tools load their own code");
  await plain.close();
});
