# vaporpress

A framework for documentation sites. It is a set of packages and conventions, not a theme: a site owns its layout, its homepage, its components and its styles, and it imports the parts of the framework that it needs.

- Markdown pages, parsed and compiled by [Sätteri](https://satteri.bruits.org) in Rust.
- Every component in Vue 3.6 Vapor mode: the pages, the layout and the components of the site.
- Routes from files, with Vue Router 5.
- A static HTML file for each page, which hydrates in the browser.
- Page changes in the browser, with no new document, and the pages of the links in view loaded ahead.

The framework lives in the AcidCat repository while it grows, and the AcidCat site (`site/`) is its first user. It moves to a repository of its own later. The package is private. Its name, `vaporpress`, is outside the names of the AcidCat packages (`acid-cat`, `@acid-cat/…`, `acid-cat-…`), because the package moves to a repository of its own.

## Use

A site is a folder with a Vite configuration, an app module and a folder of pages:

```text
my-site/
├── vite.config.ts
├── src/
│   ├── app.ts          # defineSite: the layout, the title and the head of each page
│   ├── Layout.vue      # the layout of the site, with <RouterView />
│   └── links.data.ts   # data that the build reads once
└── pages/
    ├── index.vue       # the homepage: a component of the site, not Markdown
    ├── 404.md          # the page for every path that has no page
    └── guide/
        ├── index.md    # /guide/
        └── setup.md    # /guide/setup/
```

```ts
// vite.config.ts
import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";
import { vaporpress } from "vaporpress/vite";

export default defineConfig({
  plugins: vaporpress({ root: fileURLToPath(new URL(".", import.meta.url)), app: "src/app.ts" }),
});
```

```ts
// src/app.ts
import { defineSite } from "vaporpress/client";
import Layout from "./Layout.vue";

export default defineSite({
  layout: Layout,
  title: (page) => (page.title === "" ? "My site" : `${page.title} | My site`),
  head: (page) => [{ tag: "meta", attrs: { name: "description", content: page.description ?? "" } }],
});
```

```vue
<!-- src/Layout.vue -->
<script setup lang="ts" vapor>
import { RouterView, usePage } from "vaporpress/client";

const page = usePage();
</script>

<template>
  <nav><a href="/">Home</a> <a href="/guide/">Guide</a></nav>
  <aside><a v-for="heading in page.headings" :key="heading.slug" :href="`#${heading.slug}`">{{ heading.title }}</a></aside>
  <main><RouterView /></main>
</template>
```

`vite` serves the site with live reload. `vite build` writes the static site into `dist/`: one HTML file for each page, at `<path>/index.html`, and `404.html`.

## Conventions

| Convention | Rule |
| --- | --- |
| Pages | Each `.md` and `.vue` file in the folder of the pages (`pages/` by default) is a route, as [the file-based routing of Vue Router](https://router.vuejs.org/file-based-routing/) names it. `index` is the folder itself. The URL of a page ends with a slash: `pages/guide/setup.md` is `/guide/setup/` |
| Pages from other folders | `extraPages` adds pages whose files are elsewhere, for example the files of a specification: `{ path: "/spec/catalog", file: "/abs/spec/catalog.md" }` |
| 404 | `pages/404.md` (or `404.vue`) is written to `404.html`, and the browser shows it for every path that has no page |
| Links | A plain `<a href="/guide/">` changes the page in the browser. A Markdown link needs no component. The browser loads the link itself when it opens in a new tab or window, goes to another origin, has `download`, or leads to a path that has no page, such as `/llms.txt` |
| Page data | `usePage()` gives the page on screen: `path`, `title`, `description`, `frontmatter` and `headings`. A Markdown page gets them from its frontmatter and its headings. A `.vue` page gives its own with `defineOptions({ __page: { title, description, frontmatter, headings } })` |
| Data at build time | A module whose name ends with `.data.ts` exports a loader as its default export, from `defineLoader`. The build runs the loader and gives the importer `data`, the JSON result. The browser gets the data, not the loader or what it imports |
| Head | `title(page)` and `head(page)` of `defineSite` write the title and the elements of the head that change with the page. The server writes them in each HTML file, and the browser replaces them after each page change. `headHtml` adds HTML that every page has, such as the icon |
| Components | Every `.vue` file compiles in Vapor mode, with or without the `vapor` attribute. The router registers no global component: import `RouterView` from `vaporpress/client`, and write plain links. The `RouterLink` and `RouterView` of Vue Router render virtual DOM, so the framework removes their registration from `app.use(router)` |

### Markdown pages

A Markdown page is a Vue component. It can have frontmatter, a `<script setup>` block, `<style>` blocks, and components, which it writes as HTML tags. Leave a blank line around Markdown in a component:

````md
---
title: Setup
description: How to set up the tool.
---

<script setup>
import Callout from "../../src/Callout.vue";
</script>

# Set up the tool

<Callout kind="tip">

Install it with **pnpm**.

</Callout>

```sh
pnpm add the-tool
```
````

- The title is `title` of the frontmatter, or the text of the first `h1`.
- Each heading gets an id: the slug that GitHub writes, or `{#id}` after the text. The headings of the levels in `headingLevels` (2 and 3 by default) are in `page.headings`, for the table of contents.
- Vue does not compile code: `{{` in a code block or in inline code is text.
- `{{ expression }}` in the text of a page is a Vue interpolation.
- A plain `<script>` block can export names, but it cannot have a default export.

`markdown` options:

| Option | Use |
| --- | --- |
| `transformSource(source, file)` | Changes the source before it is parsed, for example to expand a component into Markdown at build time |
| `highlight(code, language, meta)` | Returns the HTML of a code block, for example from Shiki. `meta` is the text after the language, such as `title="a.ts"` |
| `slugify(text)` | The id of a heading from its text |
| `headingLevels` | The levels of the headings in `page.headings` |
| `mdastPlugins`, `hastPlugins` | [Sätteri plugins](https://satteri.bruits.org/docs/plugins/), on the Markdown tree and on the HTML tree |

## API

| Import | Export | Use |
| --- | --- | --- |
| `vaporpress/vite` | `vaporpress(options)` | The Vite plugins: Markdown pages, Vue in Vapor mode, routes from files, data modules, the dev server and the static build |
| `vaporpress/client` | `defineSite(site)` | The site: `layout`, `title`, `head`, `scrollBehavior` and `enhance({ app, router })` |
| | `RouterView` | Shows the page of the current route. It is a Vapor component, so the site loads no virtual DOM renderer |
| | `usePage()` | The data of the page on screen |
| | `prefetchPage(router, path)` | Loads the chunk of a page before the reader goes to it |
| `vaporpress/data` | `defineLoader({ load, watch })`, `LoadedData` | A module of data that the build reads once |
| `vaporpress/markdown` | `compileMarkdown(source, file, options)`, `githubSlug` | The Markdown compiler, for tools that need the page of a file outside the build, such as a search index |

`vaporpress` options:

| Option | Default | Use |
| --- | --- | --- |
| `root` | the folder where Vite runs | The folder of the site |
| `app` | — | The module whose default export is the result of `defineSite`, relative to `root` |
| `pages` | `"pages"` | The folder of the pages |
| `extraPages` | none | A function that returns the pages whose files are in other folders |
| `markdown` | — | See [Markdown pages](#markdown-pages) |
| `lang`, `headHtml` | `"en"`, none | The language of each page, and the HTML that the head of every page has |
| `transformHtml(html, page)` | none | Changes the HTML file of each page before the build writes it |
| `vue` | — | Options for `@vitejs/plugin-vue` |

## Design

The framework follows the page model of VitePress: each page is a component of one client-side app, the router changes the page in the browser, and the pages of the links in view load ahead. It has no islands, no partial hydration and no router that swaps HTML fragments: a page change in a documentation site must feel instant, and a client-side app does that best.

### Markdown to a page

**Chosen: Sätteri writes HTML, and the Vue compiler compiles it as the template of a Vapor component.** `compileMarkdown` (`src/markdown.ts`) takes the `<script>` and `<style>` blocks out of the source, and Sätteri parses the rest. Its hast plugins give each heading an id and collect the table of contents, call the highlighter, and put `v-pre` on code. Raw HTML stays as it is, so a component tag such as `<Callout>` reaches the template, and Markdown inside it between blank lines is Markdown. The result is a single-file component: a `<script>` block with the page data, the `<script setup vapor>` block of the page, `<template>` with the HTML, and the styles. `@vitejs/plugin-vue` compiles it like any other component, so a Markdown page and a `.vue` page are the same thing to the router, the server renderer and hydration.

**Rejected: Sätteri compiles Markdown to JavaScript (`markdownToJs`), with a Vue JSX runtime.** The output is JSX calls. Vapor has no JSX runtime: the calls would make virtual DOM nodes, and the site would ship the virtual DOM renderer for every page. It would also need a second way to put components in Markdown (MDX), next to the one that `.vue` files use.

### Build and render

**Chosen: one Vite configuration, and a `buildApp` hook.** `vaporpress` returns the Vite plugins: the Markdown plugin, `vue-router/vite` for the routes, `@vitejs/plugin-vue` in Vapor mode, the data plugin, and the core plugin. `vite build` builds the client environment, then the ssr environment, then the hook renders each route with `renderToString` from Vue 3.6 and writes its HTML file (`src/prerender.ts`). The browser hydrates the page with `createVaporSSRApp`. In development, `vite` serves one HTML document for every page, and the browser renders it with `createVaporApp`. A site adds its own Vite plugins next to these.

**Rejected: a command of its own that drives Vite twice, with its own configuration file (the shape of VitePress).** It gives a second configuration format to learn and to keep in step with Vite, and a site cannot simply add a Vite plugin.

The routes are the routes of `vue-router/unplugin`: each page is a dynamic import, so each page has its own chunk. `extraPages` inserts more routes into its tree. Data that the build reads once comes from `.data.ts` modules: the plugin runs the loader in Node and gives the browser the JSON. A page imports a data module, so the data is in the chunk of the page that needs it. The experimental data loaders of Vue Router (`vue-router/experimental`) load data on each navigation; a documentation site needs no data at run time, so the framework does not use them yet.

### Fast page changes

| Part | How |
| --- | --- |
| A chunk for each page | Each route imports its page dynamically |
| Prefetch | When the browser is idle, an `IntersectionObserver` loads the chunk of each link in view. A link under the pointer, under a finger or with the focus loads at once. The loaded component replaces the loader in the route record, so the page change does not wait (`src/client/prefetch.ts`) |
| Links | One click listener on the document changes the page with `router.push` (`src/client/links.ts`). A link to a hash of the same page, such as a skip link, moves the focus to its target, so the next Tab goes on from there, as the browser does |
| Scroll | The router keeps the position when only the query changes, restores the position of a page that the reader comes back to, goes to the heading of a hash, or goes to the top. `scrollBehavior` of `defineSite` replaces this |
| Head | `src/client/head.ts`: the server writes the title and the marked elements, and the browser replaces them after a page change |

**The static HTML of a page stays out of its script in the first load.** The Vapor compiler writes each static part of a template as a string: `template("<p>Static text…", 2)`, where the flag 2 says that the template has no dynamic part. While it hydrates, Vapor takes a static template from the DOM when its string is empty, and keeps a copy of it for the next render. So the build emits a second, lean chunk of each page, with the strings of its static templates empty (`src/lean.ts`). The HTML file of a page names its lean chunk; the client gives the lean component to the route of the first page, and hydrates it. A page change loads the full chunk, which has the HTML. A template stays in the lean chunk only when hydration is sure to find its DOM: when the `setup` of the component always renders it. A template in a callback keeps its HTML: a branch of `v-if` or `v-else` that the server may not render, an item of `v-for` that comes later, a slot, or the content of `<Teleport>`. This is the same result as the lean chunks of VitePress, with no change to Vue.

**Rejected: fetch the HTML file of the next page and take its content.** It is a router that swaps HTML fragments, and it loses the state of the components of the page.

### The site and the framework

**Chosen: building blocks that a site imports.** The framework owns the build, the routes, the render and hydration, the data modules, the head, links, prefetch, and the scroll. The site owns its app module (`defineSite`), its layout, its homepage, its components and its styles. To change a part of the framework, a site does not import it, and writes its own: its own layout around `RouterView`, its own `head(page)`, its own `scrollBehavior`, or its own component in place of a built-in one. A page of one site can be a Markdown file, and the homepage can be a `.vue` file that looks like nothing else on the site.

**Rejected: a theme with slots and configuration (the shape of VitePress themes).** A theme puts the layout behind options and slots. Each change that the theme did not plan for needs a new slot, or a copy of the whole theme.

## A second site

1. Make a folder with `vite.config.ts`, `src/app.ts`, a layout and `pages/`, as [Use](#use) shows.
2. Add `vaporpress`, `vue` and `vite` to its dependencies.
3. Write the layout and the homepage of the site as its own components. Import `RouterView` and `usePage` from the framework.
4. Add the parts that the site needs: a highlighter in `markdown.highlight`, data modules, `extraPages`.
5. Run `vite build`, and serve `dist/` from a static host. `404.html` is the page for unknown paths.

`test/fixture/` is a small site that uses each part of the framework.

## Tests

`moon run vaporpress:test` runs `test/`:

- `markdown.test.ts`: the page data, the heading ids and the table of contents, components and `<script setup>` in Markdown, code that Vue does not compile, the highlighter, `transformSource`, and the lean copy of a component, which keeps the templates that hydration may not meet.
- `site-definition.test.ts`: the checks of a site definition and of a component.
- `site.test.ts`: builds `test/fixture/` and serves `dist/`. It checks the HTML, the head and the lean chunk of each page, and the data of a data module. In Chromium, it checks that hydration changes no element of the DOM and logs no mismatch, that components respond, that a click changes the page with no new document and updates the head, that the chunk of a link in view loads before the click and the chunk of a link under the pointer loads at once, that the scroll position comes back on Back and on Forward, that a hash goes to its heading, that the skip link moves the focus past the header, that a branch of `v-if`, `v-else` or `v-for` that the server did not render shows after hydration and after a page change, and that an unknown path shows the 404 page.
- `dev.test.ts`: the dev server serves a page, and a click changes the page.

`moon run vaporpress:typecheck` type-checks the sources and the tests.

## Roadmap

- Move the AcidCat site onto the framework: the docs, the specification, the examples and the packages; the homepage; the files for agents; then remove VitePress.
- Built-in features: search, the Markdown of each page and `llms.txt`, social cards, the subsets of the font faces, and the design tokens of cssforge.
- A skill that gives the checklist of the verification loop for a site.
- Move the framework to a repository of its own.
