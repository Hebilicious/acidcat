import assert from "node:assert/strict";
import { test } from "node:test";
import { compileScript, parse } from "@vue/compiler-sfc";
import { leanTemplates } from "../src/lean.ts";
import { compileMarkdown, githubSlug } from "../src/markdown.ts";

test("a Markdown page gives its title, description, frontmatter and headings", async () => {
  const source = ["---", "title: Guide", "description: How it works.", "order: 2", "---", "", "# Heading one", "", "## Second `level`", "", "### Third", "", "#### Fourth", "", "## Second `level`"].join("\n");
  const { page, sfc } = await compileMarkdown(source, "guide.md");
  assert.equal(page.title, "Guide");
  assert.equal(page.description, "How it works.");
  assert.deepEqual(page.frontmatter, { title: "Guide", description: "How it works.", order: 2 });
  assert.deepEqual(page.headings, [
    { level: 2, slug: "second-level", title: "Second level" },
    { level: 3, slug: "third", title: "Third" },
    { level: 2, slug: "second-level-1", title: "Second level" },
  ]);
  assert.match(sfc, /<h2 id="second-level">/);
  assert.match(sfc, /<h2 id="second-level-1">/);
});

test("the first heading is the title when the frontmatter has none", async () => {
  const { page } = await compileMarkdown("# From the heading\n\nText.", "page.md");
  assert.equal(page.title, "From the heading");
});

test("a page keeps its components, its script setup in Vapor mode and its styles", async () => {
  const source = ['<script setup>', 'import Note from "./Note.vue";', "</script>", "", "<Note kind=\"tip\">", "", "Inside **Markdown**.", "", "</Note>", "", "<style scoped>", "p { color: red; }", "</style>"].join("\n");
  const { sfc } = await compileMarkdown(source, "page.md");
  assert.match(sfc, /<script vapor setup>\nimport Note from "\.\/Note\.vue";\n<\/script>/);
  assert.match(sfc, /<Note kind="tip">\s*<p>Inside <strong>Markdown<\/strong>\.<\/p>\s*<\/Note>/);
  assert.match(sfc, /<style scoped>\np \{ color: red; \}\n<\/style>/);
});

test("code is not compiled by Vue", async () => {
  const { sfc } = await compileMarkdown("Use `{{ value }}`.\n\n```html\n<p>{{ value }}</p>\n```\n", "page.md");
  assert.match(sfc, /<code v-pre="">\{\{ value \}\}<\/code>/);
  assert.match(sfc, /<pre v-pre=""><code class="language-html" v-pre="">&lt;p&gt;\{\{ value \}\}&lt;\/p&gt;/);
});

test("the highlighter gets the code, the language and the meta of each block", async () => {
  const calls: string[][] = [];
  const { sfc } = await compileMarkdown('```ts title="a.ts"\nconst a = 1;\n```\n', "page.md", {
    highlight: (code, language, meta) => {
      calls.push([code, language, meta]);
      return '<pre class="shiki"><code>colored</code></pre>';
    },
  });
  assert.deepEqual(calls, [["const a = 1;\n", "ts", 'title="a.ts"']]);
  assert.match(sfc, /<pre v-pre class="shiki"><code>colored<\/code><\/pre>/);
});

test("a page can change its source before it is parsed", async () => {
  const { sfc } = await compileMarkdown("<Expand />", "page.md", { transformSource: (source, file) => source.replace("<Expand />", `Expanded in ${file}.`) });
  assert.match(sfc, /<p>Expanded in page\.md\.<\/p>/);
});

test("the plain script of a page keeps its exports and cannot have a default export", async () => {
  const { sfc } = await compileMarkdown('<script>\nexport const answer = 42;\n</script>\n\nText.', "page.md");
  assert.match(sfc, /<script>\nexport const answer = 42;\nexport default \{ __page: /);
  await assert.rejects(compileMarkdown("<script>\nexport default {};\n</script>\n", "page.md"), /cannot have a default export/);
});

test("the slug of a heading is the slug that GitHub writes", () => {
  assert.equal(githubSlug("What's new in v0.1?"), "whats-new-in-v01");
  assert.equal(githubSlug("Catalog & core"), "catalog--core");
});

const vaporModule = (template: string): string => {
  const source = `<script setup vapor>\nimport { ref } from "vue";\nconst show = ref(false);\nconst items = ref([1]);\n</script>\n<template>${template}</template>`;
  const { descriptor } = parse(source, { filename: "page.vue" });
  return compileScript(descriptor, { id: "page", inlineTemplate: true, vapor: true }).content;
};

const templatesOf = (code: string): string[] => [...code.matchAll(/_template\("((?:[^"\\]|\\.)*)"/g)].map((match) => match[1] ?? "");

test("the lean copy of a component empties the static templates that it always renders", () => {
  const code = vaporModule('<div><p>Always</p><p>here</p></div><svg><path d="M0"></path><path d="M1"></path></svg>');
  assert.deepEqual(templatesOf(code).length, 2);
  assert.deepEqual(templatesOf(leanTemplates(code)), ["", ""]);
});

test("the lean copy keeps each template that hydration may not meet", () => {
  const branches = [
    '<section v-if="show"><p>When true</p><p>x</p></section><div v-else><p>When false</p><p>x</p></div>',
    '<ul><li v-for="item in items" :key="item"><p>An item</p><p>x</p></li></ul>',
    "<Counter><div><p>In a slot</p><p>x</p></div></Counter>",
    '<Teleport to="body"><div><p>Teleported</p><p>x</p></div></Teleport>',
  ];
  for (const template of branches) {
    const code = vaporModule(template);
    assert.deepEqual(templatesOf(leanTemplates(code)), templatesOf(code), template);
  }
});
