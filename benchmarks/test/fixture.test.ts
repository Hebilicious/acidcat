import assert from "node:assert/strict";
import { test } from "node:test";
import { pageIds, parsePage, readFixture, replaceLinks, toDocus, toFramework, toStarlight, toVitePress, withoutTrailingSlash } from "../src/fixture.ts";

const page = parsePage(
  "guide/installation",
  ["---", "title: Installation", "description: Install it.", "---", "", "See [the guide](/guide/configuration/).", "", ":::tabs", "== pnpm", "```sh", "pnpm add x", "```", "== npm", "```sh", "npm install x", "```", ":::", ""].join("\n"),
);

test("the fixture has ten pages, each with a title and a description", async () => {
  const pages = await readFixture();
  assert.equal(pages.length, 10);
  assert.deepEqual(
    pages.map((entry) => entry.id),
    pageIds,
  );
  assert.equal(new Set(pages.map((entry) => entry.title)).size, 10, "a page change waits for the title of its page, so each title is unique");
});

test("a page without a title in its frontmatter is rejected", () => {
  assert.throws(() => parsePage("x", "---\ndescription: d\n---\nbody"), /needs a frontmatter with a title/);
});

test("a path loses its trailing slash for the frameworks that write none, except a section index", () => {
  assert.equal(withoutTrailingSlash("/guide/installation/"), "/guide/installation");
  assert.equal(withoutTrailingSlash("/guide/"), "/guide/");
  assert.equal(replaceLinks("[a](/reference/api/) and [b](https://example.com/)", withoutTrailingSlash), "[a](/reference/api) and [b](https://example.com/)");
});

test("VitePress gets a code group, the title as h1, and links without a trailing slash", () => {
  const { file, source } = toVitePress(page);
  assert.equal(file, "guide/installation.md");
  assert.match(source, /\n# Installation\n/);
  assert.match(source, /::: code-group\n\n```sh \[pnpm\]\npnpm add x\n```\n\n```sh \[npm\]\nnpm install x\n```\n\n:::/);
  assert.match(source, /\(\/guide\/configuration\)/);
});

test("Starlight gets an MDX page with its Tabs component, and no h1 in the body", () => {
  const { file, source } = toStarlight(page);
  assert.equal(file, "guide/installation.mdx");
  assert.match(source, /import \{ Tabs, TabItem \} from "@astrojs\/starlight\/components";/);
  assert.match(source, /<Tabs>\n<TabItem label="pnpm">\n\n```sh\npnpm add x\n```\n\n<\/TabItem>/);
  assert.doesNotMatch(source, /^# /m);
  assert.equal(toStarlight(parsePage("reference/faq", "---\ntitle: FAQ\ndescription: d\n---\nText.")).file, "reference/faq.md");
});

test("Docus gets numbered files in the order of the sidebar, a code group, and the image from public/", () => {
  const { file, source } = toDocus(page);
  assert.equal(file, "1.guide/2.installation.md");
  assert.match(source, /::code-group\n```sh \[pnpm\]\npnpm add x\n```\n```sh \[npm\]\nnpm install x\n```\n::/);
  assert.equal(toDocus(parsePage("index", "---\ntitle: Home\ndescription: d\n---\n![a](./hero.png)")).source.includes("](/hero.png)"), true);
});

test("the framework gets static tabs with roles, the first one selected, and the other panels hidden", () => {
  const { source } = toFramework(page);
  assert.match(source, /\n# Installation\n/);
  assert.match(source, /<button type="button" role="tab" id="tab-0-0" aria-controls="panel-0-0" aria-selected="true">pnpm<\/button>/);
  assert.match(source, /<div role="tabpanel" id="panel-0-1" aria-labelledby="tab-0-1" hidden>\n\n```sh\nnpm install x\n```\n\n<\/div>/);
  assert.match(source, /\(\/guide\/configuration\/\)/);
});
