import assert from "node:assert/strict";
import { stat } from "node:fs/promises";
import { join } from "node:path";
import { test } from "node:test";
import { pageId, readSpecPages, rewriteLink } from "../src/lib/spec-pages.ts";
import { readPublishedPackages } from "../src/lib/packages.ts";

const repositoryRoot = new URL("../../", import.meta.url).pathname;
const dist = new URL("../dist/", import.meta.url).pathname;

test("each specification file has a route under /spec", () => {
  assert.equal(pageId("README.md"), "spec");
  assert.equal(pageId("catalog.md"), "spec/catalog");
  assert.equal(pageId("surfaces/README.md"), "spec/surfaces");
  assert.equal(pageId("surfaces/mcp.md"), "spec/surfaces/mcp");
});

test("links between specification files stay on the site, and other links go to GitHub", () => {
  assert.equal(rewriteLink("events.md", "catalog.md", "spec"), "/spec/events/");
  assert.equal(rewriteLink("../catalog.md#bundling", "surfaces/mcp.md", "spec"), "/spec/catalog/#bundling");
  assert.equal(rewriteLink("README.md#remote-surfaces", "surfaces/mcp.md", "spec"), "/spec/surfaces/#remote-surfaces");
  assert.equal(rewriteLink("#outcomes", "invocation.md", "spec"), "#outcomes");
  assert.equal(rewriteLink("../schemas/catalog.schema.json", "catalog.md", "spec"), "https://github.com/Hebilicious/acidcat/blob/main/schemas/catalog.schema.json");
  assert.equal(rewriteLink("../schemas", "README.md", "spec"), "https://github.com/Hebilicious/acidcat/tree/main/schemas");
  assert.equal(rewriteLink("https://example.com/x.md", "README.md", "spec"), "https://example.com/x.md");
});

test("the build writes a page for every specification file", async () => {
  const pages = await readSpecPages(repositoryRoot);
  assert.ok(pages.length >= 14);
  for (const page of pages) {
    assert.ok(page.title.length > 0, page.source);
    assert.doesNotMatch(page.body, /\]\((?!https?:|#|\/)[^)]*\.md/, `${page.source} keeps a relative .md link`);
    await stat(join(dist, page.id, "index.html"));
  }
});

test("the packages page lists every package of the release configuration", async () => {
  const packages = await readPublishedPackages(repositoryRoot);
  const registries = new Set(packages.map((entry) => entry.registry));
  for (const registry of ["npm", "crates.io", "PyPI", "Go", "Pkl"] as const) assert.ok(registries.has(registry), registry);
  for (const entry of packages) assert.ok(entry.description.length > 0, entry.name);
  await stat(join(dist, "packages/index.html"));
});
