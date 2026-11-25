# AcidCat site

The homepage, the documentation, the specification and the list of packages of AcidCat. The deployed site is built with [vaporpress](../vaporpress/README.md) (`site:build-framework`). [VitePress](https://vitepress.dev) 2 with a theme of its own still builds `dist/`, for the tests that compare the two builds. It is a Moon project, and it is not published to a registry.

A click on a link to another page of the site changes the page in the browser, with no new document: VitePress loads the page from a script, and it prefetches the pages that the links in view lead to, so the new page shows at once.

## Commands

| Command | Use |
| --- | --- |
| `moon run site:dev` | Serve the site with live reload at `http://localhost:5173`, and write the design tokens again each time `cssforge.config.ts` changes |
| `moon run site:tokens` | Write the design tokens from `cssforge.config.ts` into `.cssforge/output.css` |
| `moon run site:tokens-check` | Check that `.cssforge/output.css` matches `cssforge.config.ts`. `site:test` runs it |
| `moon run site:fonts` | Write the core and the rest of each font face, and their `@font-face` rules, into `.fonts/`. Each build and `site:dev` run it first |
| `moon run site:build` | Build the static site into `dist/` |
| `moon run site:build-framework` | Build the site with [vaporpress](../vaporpress/README.md) into `.out/framework/`: the build that the Worker deploys. See [The move to vaporpress](#the-move-to-vaporpress) |
| `moon run site:test-framework` | Run the tests of the homepage, the page changes, the delivery, the fonts, the pages, the examples, the search, the three browsers and the GPU renderers on the build of vaporpress (`SITE_BUILD=framework`). `moon run verify` runs it |
| `moon run site:test` | Test the geometry of the logo, check that every design token in use exists, check that every file that an Examples page points to exists, drive the code explorer in Chromium (the tree, a file, a failed load, a deep link, the keyboard, wrapped lines and the phone layout), check that no Examples page copies a code block of the example README, render the homepage in Chromium at desktop and phone widths, check that Fig. 1 keeps its height while it loads, compare the image of each GPU renderer with WebGPU and with WebGL 2, and check that the homepage stays in its budget of bytes on a phone (images, fonts, scripts and HTML), with no texture and no renderer code of the hero on a software renderer, and no renderer code before its figure is near. Check that each page loads only files with a hash in their name, that the homepage loads no stylesheet, names each of its scripts in its head and starts them from one inline script, that no script imports the chunk of a page, that each page passes the accessibility rules of the Lighthouse audit "Accessibility tree is well-formed", that the pages with tabs or a code explorer have their roles with their scripts blocked, that each docs page shows "Edit page" and "Report issue" once at every width, that the 404 page centres its message on a phone, that the homepage passes every rule of axe-core, and that the table of contents of the docs reads no layout when the page starts (`test/delivery.test.ts`). Check that the search box is one input with the acid border at desktop and phone widths, with its results and its empty state, and that the page loads its CSS only when the search opens, in both builds; and in the vaporpress build, that the results mark the words that match, that Enter goes to a result with no new document, and that Control+K opens the search and Escape closes it (`test/search.test.ts`). Check that every page declares the icon of the site (`test/pages.test.ts`). Check that a click on a link changes the page with no new document, that the router fetches ahead the page of a link in view, that a page change from the homepage loads the CSS of the docs before the page renders, that a page change between the homepage and the docs has a page in the app at each paint, with the layout of the docs fetched ahead or not, that the root has the background of the site when the app has no page, that a page change moves no content that stays on the page (from the homepage, into the examples and out of them, at desktop and phone widths), and that the homepage stops its observers, its animation frames and its WebGL contexts when the reader leaves it, and starts them again when the reader comes back (`test/navigation.test.ts`). Check, in Chromium, Firefox and WebKit, that the homepage hydrates with no error in the console, that its Fig. 3 tabs respond, that a click on a docs link changes the page with no new document, that the language tabs switch, that the search finds a page, and that the code explorer selects a file (`test/browsers.test.ts`). CI installs the three engines. On a host outside CI where an engine does not start, such as WebKit on a Linux that is not Ubuntu or Debian, the test skips that engine and prints the reason. Check that the homepage starts its scripts without `PerformanceObserver`, without paint timing, when the browser reports no paint, in a hidden page, and when the reader comes back from another document (`test/delivery.test.ts`). Check that the hero frames 960px as a phone, and, on a hardware GPU, that it keeps its animation after a resize across 960px. Call the [AcidCat app of the site](#agents) through the Worker, an MCP client, the HTTP API and WebMCP in Chromium. Compare the build of vaporpress with the build of VitePress (`test/framework.test.ts`) |
| `moon run site:catalog` | Write `site.acidcat.json`, the catalog of the AcidCat app of the site, from its code |
| `moon run site:deploy` | Build the site, bundle the Worker, and deploy both to https://acidcat.hebilicious.workers.dev with the `cf` command. Set `CLOUDFLARE_ACCOUNT_ID` first |
| `moon run site:preview` | Build the site and the Worker, and deploy them as a Worker Preview named after the Git branch, at `https://<branch>-acidcat.hebilicious.workers.dev`. Production does not change. Set `CLOUDFLARE_ACCOUNT_ID` first |
| `moon run site:advertised -- <origin>` | Fetch each URL that `llms.txt`, the well-known documents and the `Link` header of the homepage list, from `<origin>`. The command replaces the production origin with `<origin>`, so it checks a Worker Preview before the merge. It fails when a URL does not answer 200, or when a `.md`, `.txt` or `.tar.gz` file does not have its media type. `test/agent.test.ts` runs the same check against `dist/` and the Worker, with no network |
| `moon run site:typecheck` | Type-check the geometry, the AcidCat app, the Worker, the tests and the configuration |

## The move to vaporpress

The site moves from VitePress to [vaporpress](../vaporpress/README.md). The Worker deploys the build of vaporpress. VitePress still builds `dist/` until it is removed.

| Part | Built by |
| --- | --- |
| The docs, the examples and the specification | Both. `framework.config.ts` builds them with the framework into `.out/framework/` |
| The packages page and the homepage | Both. In this build, `src/app/pages/packages.vue` and `src/app/pages/home.vue` are the routes `/packages/` and `/`. `src/app/Layout.vue` shows the homepage, or `src/app/DocsLayout.vue` for every other page. The layout of the docs is a chunk of its own (`defineLazyLayout` of vaporpress), so the homepage does not load it. `preload` gives it to the HTML of each other page, a link to such a page fetches it ahead, and the router loads it before a page change, so it renders in the same task that removes the homepage |
| The search | Both. In this build, the framework indexes the built pages, and `src/app/SearchDialog.vue` is the dialog: a modal `<dialog>` with a combobox and a list box of results. Ctrl+K and `/` open it, but `/` does nothing in a text field. The open search is an entry of the history (`?search`), so Back closes it, and a result replaces that entry. The page loads the code of the dialog when the pointer or the focus comes to the search button, and the index only when the search opens |
| The fonts, the route styles, the start of the scripts after the first paint, and the favicon | Both. The `site:fonts` task writes `.fonts/` before each build |
| The files for agents: the Markdown of each page, `content.json`, `llms.txt`, `llms-full.txt`, the agent skills, the sitemap, and WebMCP in the page | Both. `afterBuild` writes them with `src/lib/agent/files.ts` and `src/lib/sitemap.ts` |

`framework.config.ts` gives the framework the pages of `content/` (without the homepage and the packages page), the homepage, the packages page and the pages of `spec/` through `extraPages`, the components of the docs (`expandComponents`) as `transformSource`, the code frames, the heading anchors and the external links of `src/app/markdown.ts`, the font preloads and the start of the scripts after the first paint (`src/lib/preload-scripts.ts`) in `transformHtml`, and the route styles (`src/lib/route-styles.ts`) with one stylesheet (`build.cssCodeSplit: false`). The files of the build have the names of the VitePress build (`[name].[hash].[ext]`). `src/app/route-styles.ts` loads the CSS of the next route in a guard of the router, and applies it when the router confirms the page change. The figures of the homepage serve both builds: in this build, `src/app/near-figure.ts` loads each figure when its HTML from the server comes near the viewport, and the plugin `vaporCodeHtml` gives them the directive of `src/app/code-html.ts`, a Vapor directive that the server reads through `getSSRProps`. The components write `role` beside `data-role` in this build (`roles: true`), so the HTML of each page has its roles before a script runs. `src/lib/markdown/code-frame.ts` (the frame of a code block) and `pageCard` in `src/lib/social.ts` (the canonical URL and the cards of a page) serve both builds. In this build, the browser does not load the script of the code explorer on a page that has no code explorer, and the Open Graph and Twitter cards are only in the HTML, for the crawlers that read it: the head that the browser writes after a page change has the title, the description and the canonical link. `src/app/` holds the app module of the site (`app.ts`), its layout in Vapor mode (`Layout.vue`), the search button and its dialog (`SearchButton.vue`, `SearchDialog.vue`), the sidebars of the sections (`sections.data.ts`), the head of each page (`head.ts`), and the parts of the theme that read VitePress: the header, the sidebar, the table of contents, the active heading and the page behaviors. The other parts of `src/theme/`, such as `PageActions.vue` and `Pagination.vue`, serve both builds.

`test/framework.test.ts` checks that the framework builds every page that VitePress builds, that each page hydrates with no error, that the homepage, the packages page and the pages of the docs look the same as the VitePress pages at 1440 and 390 pixels, search box included, to one level of each channel, except the turned diamond under the header, that the pages with tabs or a code explorer have their roles with their scripts blocked, that "Edit page" and "Report issue" lead to the source and to a new issue, and that a click changes the page with no new document and starts the tabs of the new page.

## Deployment

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) deploys the site when a commit reaches `main`. It is connected to the Worker `acidcat`, and it runs `bash site/scripts/cloudflare.sh build`, then `bash site/scripts/cloudflare.sh deploy`, from the root of the repository. The script installs proto, then Node, pnpm and Moon from `.prototools`, then the dependencies with `pnpm install --frozen-lockfile`, and runs `site:build-framework` or `site:deploy`. Workers Builds gives `site:deploy` the account and the token. A build starts only when a commit changes a file that the build reads: `site/`, `vaporpress/`, `spec/`, `schemas/`, `examples/`, `packages/`, `skills/`, the release files, and the files of the toolchain and the workspace.

The Worker has code and assets. `cf` builds a project with a Worker entrypoint through the framework's own command, and VitePress writes only static files. So `site:deploy` runs `site:build-framework`, then `scripts/worker-output.ts`, which bundles `worker/index.ts` with esbuild and writes the [Build Output](https://developers.cloudflare.com/cf/projects/#deploy-a-prebuilt-build) in `.cloudflare/output/v1/`: the bundle, `.out/framework/` as the assets, and the settings of `cloudflare.config.ts`. Then `cf deploy --prebuilt` uploads it. `site:preview` does the same with `cf previews deploy --prebuilt`.

The Worker runs first only for the paths in `workerPaths` of `cloudflare.config.ts`: the pages, `/mcp`, `/api` and the well-known documents that it writes. For a page, the Worker reads the file from the assets binding and adds the headers. It makes the MCP server and the HTTP API only when a request for them comes. Other files, such as `/assets/*`, go to the assets directly.

## Structure

| Path | Contents |
| --- | --- |
| `.vitepress/config.ts` | The configuration of VitePress: the pages, the head of each page, the Markdown, the search and the steps after the build |
| `.vitepress/theme/index.ts`, `src/theme/` | The theme. `Layout.vue` shows the homepage, or `DocsLayout.vue` for every other page: the header, the sidebar of the section, the content, the table of contents, and a footer with "Edit page", "Report issue" (`PageActions.vue`) and the links to the next pages. The theme has the look of the site and uses no CSS of the default theme of VitePress |
| `src/theme/page-behaviors.ts`, `src/theme/tabs.ts` | Start the tabs and the code explorers of each page when its content is in the DOM, and stop them when it leaves |
| `src/theme/active-heading.ts` | Marks the heading at the top of the content in the table of contents, with an `IntersectionObserver`, so the page reads no layout |
| `src/theme/SearchButton.vue`, `src/styles/search.css` | The local search of VitePress, in the palette of the site. The page loads its CSS when the reader opens the search. VitePress builds its index from each page; `searchRender` in `src/lib/markdown/setup.ts` gives it the pages of the specification and the packages |
| `content/` | The pages. `content/index.md` is the homepage, `content/docs/` the documentation, `content/examples/` the examples, `content/spec/[page].md` the pages of the specification, and `content/packages/index.md` the packages |
| `src/components/HomePage.vue`, `src/components/near-figure.ts` | The homepage. It does not use the layout of the docs. `near-figure.ts` loads each figure under the hero when it comes near the viewport |
| `src/components/LivingPlate.vue`, `src/lib/living-plate.ts` | The hero: the key art as a still image, and a canvas that brings it to life |
| `src/lib/plate-renderer.ts`, `src/lib/plate-shader.ts`, `src/lib/plate-framing.ts` | The renderer of the hero and its shader. `plate-framing.ts` frames the still image and the canvas, so the still image does not wait for the renderer |
| `src/lib/gpu/` | A full-screen shader pass for the hero and the blue screens. It draws with WebGPU when the browser gives a hardware adapter, and with WebGL 2 otherwise. Each shader is written once, in a subset of GLSL ES 3.00 that `shader.ts` gives to WebGL 2 and `wgsl.ts` translates to WGSL, so both backends draw the same image |
| `src/components/Schematic.vue`, `src/lib/schematic.ts` | Fig. 1: one capability of the catalog, and what each surface makes from it |
| `src/lib/holo.ts`, `src/lib/catalog-engine.ts`, `src/lib/engine-hardware.ts`, `src/lib/engine-finish.ts`, `src/lib/engine-shader.ts`, `src/lib/nixie-scene.ts` | Fig. 1 in 3D: worn brass screens, glass pipes and a rail of Nixie bulbs in three.js, with the HTML of each screen drawn by HTML-in-Canvas. The custom materials are TSL node materials |
| `src/components/Blueprint.vue`, `src/components/Exploded.vue` | Fig. 2: an animated blueprint of the flow Spec, Catalog, Core and Verify, and the key specifications on a blue screen |
| `src/components/Surfaces.vue`, `src/lib/surfaces.ts`, `src/lib/surface-tabs.ts`, `src/assets/surfaces/`, `art/surfaces/` | Fig. 3: the five surfaces in tabs, each with a render, an example and a gauge |
| `src/components/CoreScreens.vue`, `src/lib/core-console.ts`, `src/lib/bluescreen.ts`, `src/lib/bluescreen-shader.ts` | Fig. 4: how to use each core, on a console drawn with HTML-in-Canvas |
| `src/lib/home-code.ts`, `src/components/home.data.ts`, `src/components/home-code.data.ts`, `src/components/code-html.ts` | The code of the homepage figures. The data loaders read it at build time. The highlighted code is in the HTML that the server writes, and not in the JavaScript of the page: the directive `v-code-html` gives it to the server only, and Vue keeps the children of an element that has none in the browser. After a page change in the browser, the directive loads the code from its own chunk |
| `src/lib/snippets.ts`, `src/lib/highlight.ts` | Read the code examples from `examples/aircon` and the READMEs of the cores at build time. `highlight.ts` is the Shiki highlighter of the homepage and the code explorer: it colors the code with the variables of `src/styles/code.css` |
| `src/styles/code.css` | Maps the colors of the code to the palette |
| `src/theme/Mark.vue`, `src/assets/mark.svg`, `src/assets/favicon.svg`, `src/lib/favicon.ts`, `art/logo/` | The logo (a brass cat in profile), the favicon, and the explorations behind them. `favicon.ts` writes the favicon to `/assets/` with a hash, names it in the head of every page, and redirects `/favicon.ico` to it |
| `src/lib/geometry.ts` | Pure functions that compute gears |
| `src/lib/docs-sidebar.ts`, `src/lib/spec-pages.ts` | The sidebar of each section: the docs and the examples from the frontmatter of each page (`sidebar.order` and `sidebar.label`), and the specification in the order of its pages |
| `src/lib/ecosystem.ts` | The one list of catalog languages and cores. Every page and component that shows them reads it, and the build fails when one has no example. `test/ecosystem.test.ts` fails when it disagrees with `packages/`, and when a page writes a count or a list of languages or cores by hand ("five languages") |
| `src/lib/markdown/components.ts` | The components of the docs. A page writes each one like a Vue component, for example `<CatalogExample capability="aircon.power.set" />`, and it becomes Markdown before the page renders, so a missing file fails the build. They render static HTML: Vue keeps static HTML as one string, and VitePress leaves it out of the script that starts the page. See [The components of the docs](#the-components-of-the-docs) |
| `src/lib/markdown/setup.ts` | Renders the components of the docs before each page, puts each code block in a frame (an editor tab with its file name, or a terminal), and gives the search the Markdown of each page |
| `content/examples/`, `src/lib/example-files.ts`, `src/lib/example-highlight.ts`, `src/lib/example-fragments.ts`, `src/lib/markdown-fences.ts`, `src/lib/code-explorer.ts`, `src/styles/explorer.css` | The Examples section, served under `/examples/`, and its code explorer. See [The examples](#the-examples) |
| `src/lib/catalog-examples.ts` | Read each definition of the aircon catalog from its five sources and its canonical JSON at build time, for the language tabs |
| `src/lib/external-links.ts` | Tells which links go to another website. The Markdown opens them in a new tab, and `test/pages.test.ts` fails when a built page has an external link that does not |
| `src/lib/spec-diagrams.ts`, `src/styles/diagrams.css` | The SVG diagram that replaces the ASCII diagram of the specification |
| `src/lib/spec-pages.ts`, `content/spec/[page].paths.ts` | Load each file of `spec/` into a page of the dynamic route `content/spec/[page].md` at build time, served under `/spec/` |
| `src/components/PackagesPage.vue`, `src/components/packages.data.ts`, `src/lib/packages.ts`, `src/lib/packages-page.ts`, `src/lib/package-groups.ts` | The list of published packages, served under `/packages/` |
| `src/lib/code-theme.ts`, `src/styles/docs.css`, `src/styles/content.css` | The palette of the site in the docs: the layout, colors, fonts, code blocks, and the dark theme only |
| `src/lib/page-head.ts`, `src/lib/social.ts` | The title, the canonical link and the Open Graph and Twitter cards of each page |
| `src/lib/route-styles.ts`, `src/lib/routes.ts`, `src/theme/route-styles.ts` | Split the stylesheet of the site by route (the homepage, the docs and the search), write the CSS of its route into each page after the build, and load the CSS and the font faces of another route when the reader goes to it. See [Loading](#loading) |
| `src/lib/page-chunks.ts` | Puts the modules that only one page imports in a chunk of their own, when that page also imports a module dynamically, so that each module runs once. See [Loading](#loading) |
| `src/lib/preload-scripts.ts` | Names each script that a page loads at once as a preload link of its head, and starts the scripts after the first paint. See [Loading](#loading) |
| `src/lib/server-roles.ts` | Adds `role` to each element that has `data-role` in the built HTML. See [Loading](#loading) |
| `src/lib/content-types.ts` | The media type of each kind of file in the build, as Cloudflare serves it. The server of the tests and the server of the Lighthouse run send each file with it, and `test/pages.test.ts` fails when a file of the build has no type in it |
| `src/lib/sitemap.ts` | Writes `/sitemap-index.xml` and `/sitemap-0.xml` |
| `cloudflare.config.ts` | The Worker that serves the site: its name, its entrypoint, the paths that run the Worker first, the assets binding, and the 404 page for unknown paths |
| `worker/index.ts`, `worker/discovery.ts` | The Worker. It serves the MCP server and the HTTP API of the AcidCat app, the well-known documents, Markdown to a client that asks for it, and the `Link` header of each page. Everything else comes from the assets |
| `scripts/worker-output.ts` | Bundles the Worker, and writes the Build Output that `cf` uploads |
| `scripts/advertised.ts`, `scripts/check-advertised.ts` | Find each URL that the documents for agents list, and fetch it as an agent does. `site:advertised` and `test/agent.test.ts` use them |
| `src/lib/agent/` | The AcidCat app of the site (`app.ts`), the content that it reads (`content.ts`), its WebMCP tools in the page (`page.ts`), the Markdown of the homepage (`home.md`), and the files for agents that the build writes (`files.ts`) |
| `site.acidcat.json` | The catalog of the AcidCat app of the site. `site:catalog` writes it from `src/lib/agent/app.ts`, and `test/agent.test.ts` fails when it is stale |
| `src/lib/page-markdown.ts` | Converts the HTML of a built page into Markdown: the content of the page, each panel of a tab group under the label of its tab, and each code block with its language |
| `.vitepress/theme/index.ts` | Loads the WebMCP tools in a browser that has `document.modelContext` or `navigator.modelContext`. Other browsers load none of their code |
| `public/robots.txt` | The crawl rules: every crawler, and each AI crawler by name, can read every page. It gives the Content Signals of the site and the sitemap |
| `public/_redirects` | The permanent redirects of the Worker, from the old URLs of the specification and the docs to their new URLs. `test/pages.test.ts` fails when a redirect leads to no page |
| `public/_headers` | The cache headers of the Worker. The files in `/assets/` have a hash in their name, so the browser keeps them for a year. Each file that a page loads is in `/assets/`: the images, the fonts and the search index are imports, not files in `public/` |
| `cssforge.config.ts` | The design tokens: colors, fluid type and spacing scales, font families, tracking, radii and layout widths. [cssforge](https://github.com/Hebilicious/cssforge) writes them as CSS variables into `.cssforge/output.css`, which is committed |
| `src/styles/site.css`, `src/styles/tokens.css` | The stylesheet of the site, and the design tokens and the fonts that the homepage and the documentation share |
| `src/lib/fonts.ts`, `src/lib/font-faces.ts` | Splits each font face into a small core file and the rest at build time, writes their `@font-face` rules into `.fonts/`, and gives each page a preload link for the faces that it draws first. `font-faces.ts` lists the faces of the first view of each route |
| `src/assets/hero/`, `src/lib/plate-crop.ts` | The hero textures, and the columns of the key art that the phone plates keep. `art/pack.sh` writes the textures |
| `public/og/`, `art/og/build.sh` | The Open Graph and Twitter card of each section (home, docs, examples, spec, packages). `art/og/build.sh` writes the 1200 by 630 images from the key art, the logo and the Monaspace fonts; `test/pages.test.ts` fails when a page has no card |
| `art/` | The sources of the hero art, and the scripts that make the textures |

## Art direction

The art is futuristic steampunk: polished brass, copper and dark steel, with acid-green plasma, cyan holograms and Nixie-tube amber, on midnight ink. The main character is a mechanical cat.

| Variable | Color | Use |
| --- | --- | --- |
| `--palette-ink-900` | `#0b0e14` | Background |
| `--palette-brass-400` | `#c9a227` | Plates, frames, headings |
| `--palette-copper-400` | `#b87333` | Filigree, joints |
| `--palette-acid-400` | `#b6ff3b` | Fluid, glow, primary action |
| `--palette-cyan-400` | `#3be8ff` | Holograms, blueprints, the active surface |
| `--palette-nixie-400` | `#ff8a3d` | Nixie tubes |
| `--palette-cream-100` | `#f2e6c9` | Text |

The CSS uses only the design tokens: colors (`--palette-*`, in OKLCH), sizes (`--typography_fluid-text-*`, `--typography_fluid-display-*`), spacing (`--spacing_fluid-space-*`), `--font-family-*`, `--font-tracking-*`, `--radius-size-*` and `--layout-*`. For transparency, it mixes a color with `transparent`: `color-mix(in oklch, var(--palette-acid-400) 40%, transparent)`.

The fonts are from [Monaspace](https://monaspace.githubnext.com/): Xenon for headings, Radon for the accent words in headings, Argon for text, Krypton for labels and Neon for code. Texture healing (`calt`) is on. cssforge has no Vite plugin, so `site:dev` runs `cssforge --watch` next to VitePress.

`src/lib/fonts.ts` splits each face of Monaspace in two files before the build (the `site:fonts` task), and writes them with their `@font-face` rules into `.fonts/` (not in git). The core file has ASCII and the few other characters that the site uses, with all the OpenType features, at about half the size of the full face. The full face serves the other characters, with a `unicode-range`, so the browser downloads it only for a page that has one of them. `test/fonts.test.ts` fails when a page has a character outside the core: add it to `coreRanges`. It checks the text of each built page, and in Chromium it also checks the characters that the browser draws beside the text: list markers (a bullet is a character of the font), generated content, and the text that scripts write, such as the command key of the search button on macOS.

## The hero

`art/key-art.png` is the key art. The hero reproduces it, and makes it move. The textures come from these sources:

| File | What it is | Made by |
| --- | --- | --- |
| `key-art.png` | The key art, 1672×941 | Image generation |
| `key-art-wide.png` | The key art, extended 728 px to the left for the headline, 2400×941 | Image generation (outpainting). The right 1672 px are the pixels of `key-art.png` |
| `clean-plate-wide.png` | The scene without the cat, the pedestal and the rings | Image generation (inpainting). It is equal to `key-art-wide.png` outside `cut-mask-wide.png` |
| `cut-mask-wide.png` | The region that the clean plate replaces | The inpainting step, with the matte dilated |
| `depth-wide.png` | A depth map | `derive.py` (Depth Anything V2 Large, CC-BY-NC-4.0) |
| `matte-wide.png` | The cat, the pedestal and the brass bands | `derive.py` on `key-art.png` (BiRefNet, MIT), padded to the wide size |
| `plate-wide@2x.png` | The wide key art at twice the size | `derive.py` (Swin2SR, Apache-2.0) |

`uv run --script art/derive.py art/key-art-wide.png <directory>` writes the depth map, the matte and the large plate. It needs an NVIDIA GPU to run in a few minutes. `art/pack.sh` packs the depth, the matte and the cut mask into `src/assets/hero/data.webp` (lossless WebP), and writes the plates as AVIF and WebP. It needs ImageMagick and `avifenc`.

The plates are AVIF with full color resolution (4:4:4). At less than half the bytes, they are closer to the source than the WebP plates, which keep only a quarter of the color resolution (4:2:0). The still image is the LCP element. A `<picture>` gives it as AVIF, and as WebP to browsers without AVIF.

At 960px and below, the hero has a fixed aspect ratio, so it always shows the same columns of the key art. There, the `<picture>` gives a phone plate: the columns of `phoneCrop` in `src/lib/plate-crop.ts`, with a margin for the parallax, at 840, 1052 and 2104 pixels wide. The browser downloads less than half the bytes of the full plate, at the same resolution. The renderer maps the phone plate onto the key art with the uniform `uPlateRect`. When a resize across 960px gives the still image the other plate, the renderer draws from that plate and its columns, and the animation continues. At exactly 960px, the hero is a phone hero. The renderer loads the file that the browser chose for the still image from the `srcset`, so the browser downloads the plate once. It starts after the still image has loaded, so its textures do not take bandwidth from the LCP image.

The shader shifts the cat against the background with the depth map, as the pointer moves. Where the cat moves away, the clean plate shows. It also makes the eyes and the chest reactor pulse, sends light around the holographic rings, floats the brass bands, flickers the Nixie tubes, sparks the fibre optics, moves the plasma, steam and dust, and lights the brass where the pointer is. When the camera is still, the output is the key art.

The renderer uses WebGPU when the browser gives a hardware adapter, and WebGL 2 otherwise. It lowers its resolution when frames are slow. The still image stays when the browser renders in software, when neither WebGPU nor WebGL 2 is available, and when the reader asks for reduced motion. In these cases the page does not download the other textures of the hero.

The renderer checks the GPU before it downloads the textures. It decodes each texture into an `ImageBitmap` off the main thread, and it uploads the next texture only when the GPU has taken the one before it, so no upload blocks the main thread. The canvas has its final size before the renderer makes its context, so the drawing buffer is allocated once.

## Loading

- **Page changes.** VitePress changes the page in the browser. When a link comes into view, VitePress prefetches the script of its page at low priority, so a click shows the page at once. Each figure of the homepage starts its renderers, observers and animation frames, and loads its highlighted code after a page change, when it comes near the viewport, so the hero renders first. Each figure stops them, and frees its WebGL and WebGPU contexts, when it unmounts. When the reader points at, focuses or touches a link to the homepage, the page preloads the still image of the hero in the size that the screen uses.
- **Static content.** Vue keeps static HTML as one string, and VitePress leaves these strings out of the script that starts a page (the `.lean.js` file). So the components of the docs render static HTML, and the code of the homepage figures is only in the HTML. Vue keeps static HTML as one string only when each attribute is a known HTML attribute, and `role` is not one: the components write `data-role`. `src/lib/server-roles.ts` adds `role` to the HTML of each built page, so a page has its roles before a script runs, and the page sets `role` after a page change in the browser.
- **Styles.** VitePress writes one stylesheet. A PostCSS plugin (`markRoutes` in `src/lib/route-styles.ts`) wraps the CSS of each route in `@supports (--acidcat-route: <route>)`, by the file that the CSS comes from: the homepage, the docs or the search. Every browser that reads custom properties passes this condition, so the wrapper changes nothing on the page. After the build, `inlineStyles` splits the stylesheet at these wrappers. It writes into each page the CSS that every page shares and the CSS of its route, so no stylesheet blocks the first render, and it writes the CSS of each route to `/assets/<route>.<hash>.css`. On a page change to another route, `src/theme/route-styles.ts` loads the CSS of that route while VitePress loads the script of the page, in the order of the build. The CSS applies to print only until the page renders, so it does not change the page that the reader still sees. The page renders when both are there. When the browser is idle after the load (after the load, in a browser without `requestIdleCallback`), the page fetches ahead the CSS of each other route that one of its links leads to, as VitePress does for the scripts of the pages. The search loads its CSS when it opens.
- **Scripts.** The head of each page names each script that the page loads at once as a `preload` link, so the browser fetches them all together with the HTML. This includes the scripts that other scripts import, at any depth. A preload link does not compile the script, as a `modulepreload` link does. One inline script imports the scripts when the document is parsed and the browser reports its first paint (`src/lib/preload-scripts.ts`), so the browser paints the page from the server before it evaluates Vue and hydrates the page. The inline script listens for the load event first, and imports the scripts then at the latest, so a page that reports no paint, such as the 404 page, still starts. A hidden page, such as a background tab or a prerender, imports them when the document is parsed, as does a browser without `PerformanceObserver` or paint timing. A page that the back-forward cache restores imports them when it shows, if they did not start before.
- **Figures of the homepage.** Each figure under the hero loads its code when its HTML from the server comes near the viewport, and hydrates when the code arrives (`src/components/near-figure.ts`). Until then, the HTML from the server shows the figure. After a page change in the browser, each figure loads at once. The renderer of the hero loads after the still image decodes, and only on a hardware GPU, so the first script of the homepage carries only the layout of the hero.
- **One copy of each module.** VitePress copies the chunk of each page into a `.lean.js` file, and the browser starts the page from the copy. A module in the chunk of the homepage that a figure also imports would then run twice, and the figure would download the full chunk. `src/lib/page-chunks.ts` puts the modules that only one page imports in a chunk of their own, when that page also imports a module dynamically. `test/delivery.test.ts` fails when a script imports the chunk of a page.
- **No layout shift on a page change.** On a page change, the content area of the docs is new, so content that changes its place with the layout, such as the content beside the table of contents, does not move: it replaces the old content. The page renders when the core files of the font faces that its route draws first are there, so no text moves when a face arrives.
- **Layout.** The sections under the hero, and the footer, have `content-visibility: auto`. The browser computes their style and their layout only when they come near the viewport, so the first layout of the page is short. Each section has an estimate of its height (`contain-intrinsic-size`), and the browser keeps its real height after the first layout. On a docs page, each code block and each group of tabs has `content-visibility: auto` too, because the code blocks hold most of the elements of the page.
- **Budget.** `test/home.test.ts` checks the bytes that the homepage loads on a phone before the reader acts, by type, against budgets with names: the phone plate, the cores of the fonts, the scripts of Vue, VitePress and the homepage, the HTML of the homepage with its CSS, the star count, the prefetch of the index page of each section in the header, and the prefetch of the CSS of the docs. Each budget is the size of the build, with a margin of about 3%. A change that makes the homepage larger changes its budget in the same pull request.
- **Fonts.** Each font stack ends with the generic `monospace` and names no local font. The browser looks up each local font that a stack names during the first layout, and on a system that does not have it, such as Linux with `ui-monospace`, `SFMono-Regular` or `Menlo`, the lookup makes the first layout several times longer.
- **Raster.** A gradient that fades one color to transparent names `in srgb`. Between colors of CSS Color 4, a gradient interpolates in OKLab by default, and a software rasterizer draws that slowly. In sRGB, such a gradient gives the same pixels. A gradient between two hues keeps OKLab. The gradients of the page backgrounds of the homepage and the docs fill their box, and have `no-repeat`: Chromium rasters a repeated gradient as one image of its whole tile before the first frame, and a gradient with no repeat only in the tiles on screen. The gradient is the same. Chromium draws it directly and not as one image of a tile, so a pixel can differ by one level of 255 in a channel: on the quick start at 400 px, about 98,000 pixels do, and on the homepage, the introduction and a page of the specification, none. On GitHub's runners, which raster in software, this takes the raster of the first frame of the homepage from 134 ms to 14 ms, and the task of its first frame on the main thread from 71 ms to 11 ms (medians of 36 loads).
- **Requests to other websites.** The number of stars on GitHub and the latest versions on the packages page load at low priority, so they do not take bandwidth from the page.
- **Cache.** Each file that a page loads has a hash in its name, so the browser keeps it for a year.

## Lighthouse

`moon run site:lighthouse` builds the site with vaporpress, and serves `.out/framework/` from memory as the Worker does: it compresses each text file with Brotli once when it starts, as Cloudflare serves a compressed file from its cache, and it sends the cache headers of `public/_headers` and the media type of each file from `src/lib/content-types.ts`. It runs [Lighthouse](https://developer.chrome.com/docs/lighthouse) on mobile (simulated throttling) on `/` and `/docs/quick-start/`, five times each, in the Chromium of Playwright. It writes each report as HTML and JSON, and a summary table, into `.tmp/lighthouse/`. It fails when one of these budgets does not hold:

- Each run of each page passes the audits that pass or fail: "Network dependency tree", "Forced reflow", "Improve image delivery", "Render blocking requests", "Layout shift culprits", "Cumulative Layout Shift" and "Accessibility tree is well-formed" (Agentic Browsing).
- The median score of each category is at least its budget in `scripts/lighthouse.ts`.

The run blocks the request of the homepage for the star count, so it does not use the network, and the console error that the block makes is one that Lighthouse ignores. The budgets come from nine runs of the job on the runners, with five runs of each page in each job. Each budget of a median is the lowest median of a job, less 5 points:

| Page | Category | Each run | Median of each job | Budget of the median |
| --- | --- | --- | --- | --- |
| `/` | Performance | 85 to 94 | 87 to 94 | 82 |
| `/docs/quick-start/` | Performance | 97 to 100 | 100 | 95 |
| Both | Accessibility, Best practices, SEO | 100 | 100 | 100 |

Each audit that passes or fails passed in each of the 90 runs.

The workflow [`lighthouse.yml`](../.github/workflows/lighthouse.yml) runs the task on a runner of GitHub for each pull request that changes a file that the built site reads: the same files that start a build of Workers Builds (see [Deployment](#deployment)), and the workflow itself. It writes the summary table to the job summary, and uploads the reports as the artifact `lighthouse-reports`. Local results are not comparable: the score of a run depends on the load of the machine.

## The GPU renderers

The hero, Fig. 1 and the blue screens draw with WebGPU when `navigator.gpu` gives a hardware adapter (a low-power one, so that it shares the GPU of the compositor), and with WebGL 2 otherwise. Code for WebGPU and three.js loads only when a renderer needs it. Each shader has one source, so both backends draw the same image.

`src/lib/gpu/support.ts` tells whether the browser draws on a hardware GPU without blocking the main thread:

- **WebGPU.** The first device clears a texture of one pixel and reads it back. Some adapters give a device that draws nothing and reports no error until a read. When the read fails, the renderers use WebGL 2.
- **WebGL 2.** A worker makes a WebGL 2 context on an `OffscreenCanvas` and reads the name of the renderer. A name such as SwiftShader or llvmpipe is a software renderer. The worker stays open, because the main thread spends about 30 ms to release a worker that made a WebGL context.

Fig. 1, Fig. 2 and Fig. 4 start their renderer only when they come near the viewport, so none of them makes a context or loads its code while the page loads. The full-screen pass compiles its WebGL 2 shader in the background with `KHR_parallel_shader_compile`, and its WebGPU pipelines with `createRenderPipelineAsync`.

`test/gpu-parity.test.ts` renders the hero (after three seconds on a frozen clock), the wide and the tall Fig. 1, Fig. 2 and Fig. 4 (as still frames) with each backend in Chromium, and compares the pixels. Two images match when the mean difference of their channels is at most 1.5 of 255, and at most 0.5% of their pixels differ by more than 32 in a channel. The test needs a hardware GPU: it launches Chromium with `--enable-gpu --ignore-gpu-blocklist --use-gl=angle --use-angle=gl-egl --enable-unsafe-webgpu --enable-features=Vulkan --enable-blink-features=CanvasDrawElement`. On a machine with no hardware WebGPU or WebGL 2, such as CI, the test is skipped, and it prints the reason.

## The specification

The site does not copy the specification. At build time, `spec-pages.ts` reads each Markdown file of `spec/`, takes the first heading as the title, and rewrites the links: a link to another file of `spec/` goes to its page under `/spec/`, and a link to any other file of the repository goes to GitHub. `content/spec/[page].paths.ts` gives these pages to the dynamic route `content/spec/[page].md` of VitePress, so they have the sidebar, the search and the table of contents. In `site:dev`, a change to `spec/` loads the pages again.

## The components of the docs

A page of the docs is Markdown. `src/lib/markdown/components.ts` replaces each component of the docs with Markdown or static HTML before the page renders. A component that reads a file fails the build when the file does not exist.

| Component | What it renders |
| --- | --- |
| `<CatalogExample capability="…" />` | One definition of the aircon catalog in each catalog language and in JSON, in language tabs. `target`, `type` and `event` choose other entries |
| `<EcosystemTable of="cores" />`, `<EcosystemInstall of="…" />` | The table and the install steps of the catalog languages or the cores of `ecosystem.ts` |
| `<EcosystemTabs of="cores">` | One tab for each entry of `ecosystem.ts`. The page writes the content of each tab in `<TabItem for="core-ts">`, and the build fails when one is missing |
| `<Tabs sync-key="…">` with `<TabItem label="…">` | Tabs written by hand. Groups with the same sync key change together, and the browser keeps the choice for the next pages |
| `<PackageInstall packages="…" dev />`, `<PackageRun command="…" />` | The commands for pnpm, npm, yarn and bun, in tabs |
| `<CodeExplorer open="…" />`, `<FileLink file="…" />`, `<ExampleBlock section="…" />`, `<CatalogSources />`, `<CoreExamples />` | The code explorer and the commands of the examples. See [The examples](#the-examples) |
| `<CatalogSteps />`, `<CatalogWrite />`, `<CoreGuides />`, `<OwnCore />`, `<CatalogFlow />` | The steps of each catalog library, the commands that write the JSON, the links to the guides of the cores, how to write your own core, and the diagram of the catalog |
| `<CardGrid>`, `<LinkCard title="…" href="…" />`, `<Steps>` | Cards and numbered steps |
| `::: note`, `::: tip`, `::: caution`, `::: danger` | An aside. A word after the type is its title |

A code block with `title="file.ts"` after its language shows the file name in an editor tab. A shell code block shows as a terminal.

## The examples

The Examples section, under `/examples/`, has its own sidebar and its own link in the header. It has one page for each program of `examples/` that a reader runs: the catalog in each language, the application on each core, the web page with WebMCP, and each API. Each page has a short introduction, the commands that run the program, and a code explorer.

The site does not copy the code or the commands of the examples. At build time, `example-files.ts` lists the files of each directory of `examples/` with `git ls-files --cached --others --exclude-standard`, so it leaves out what the `.gitignore` files leave out: dependencies, build output and the `target/` directories of Cargo. It also leaves out lock files. A new file or a new example appears in the explorer without a change to the docs. The build needs git.

- `<CodeExplorer open="core-ts/aircon.ts" />` shows the tree of `examples/aircon` and opens one file. `<FileLink file="core-ts/cli.ts" />` links to a file in the explorer of the page. The build fails when either one points to a file that does not exist.
- `<CatalogSources />` lists the catalog source of each language of `ecosystem.ts`, and `<CoreExamples />` links to the page of each core. The build fails when a core has no page, and `test/examples.test.ts` fails when the page of a core does not open a file of its example.
- `<ExampleBlock section="Run an API" match="apis/main.ts" />` shows a code block of the README of the example. It takes the blocks under that heading, and keeps the commands that contain `match`; `language` chooses one block. `markdown-fences.ts` reads the blocks. The build fails when the heading or the match is not in the README, and `test/examples.test.ts` fails when a page copies a line of a code block of the README.
- `example-highlight.ts` highlights each file with `highlight.ts`. The built HTML of a page holds the highlighted HTML of the file that it opens, and the script of the page does not: `writeExplorerSources` writes it into the HTML after the render. So a prefetch of an Examples page, for example from the link in the header, does not carry the file. After a page change in the browser, the explorer loads the file that it opens as a fragment. `example-fragments.ts` writes the HTML of every file, after the build, into `/example-files/<example>/<path>.json`, and the explorer loads one only when the reader selects it.
- `code-explorer.ts` is the script of the explorer, with no framework. `src/theme/page-behaviors.ts` starts it when the page mounts, and stops it when the page leaves. The tree follows the [WAI-ARIA tree pattern](https://www.w3.org/WAI/ARIA/apg/patterns/treeview/): the arrow keys, Home, End, Enter and Space. When the tree gets the focus again, the focus goes to the selected file. The selected file is in the URL (`#file=core-ts/aircon.ts`), so a reload or a shared link opens it. A file that fails to load loads again when the reader selects it again. Long lines wrap, as in each code block of the site, and the wrapped rows start under the code. A button hides the tree, and another button shows the explorer in full screen. Below 50rem, the tree is a drawer over the code, and it closes when the reader selects a file.

## The packages

`/packages/` lists every package of `release-please-config.json`, so a package appears when its release is set up. The version on each card is the version in `.release-please-manifest.json`, and the description comes from the manifest of the package (`package.json`, `Cargo.toml`, `pyproject.toml`) or from `packages/README.md`. In the browser, the page asks each registry (npm, crates.io, PyPI, the Go module proxy, and the tags of the Pkl package on GitHub) for its latest version, and shows it.

## The sections

- **Fig. 1.** In browsers that support [HTML-in-Canvas](https://github.com/WICG/html-in-canvas), `holo.ts` loads the `WebGPURenderer` of three.js when the machine comes near the screen, and builds a machine of worn brass: the catalog screen, five surface screens, glass pipes with flowing acid, and a rail of five Nixie bulbs above the catalog screen. The text of each screen is live HTML in a `<canvas content="drawable">`. The renderer uses WebGPU when the browser gives a hardware adapter and `drawElementImageToTexture`, and WebGL 2 otherwise. The materials are written once in TSL, which three.js compiles to WGSL or to GLSL, so both backends draw the same machine. On each `paint` event, `drawElementImageToTexture` (WebGPU) or `texElementSubImage2D` (WebGL 2) copies the HTML of each screen into its texture, and a CRT shader draws it with its syntax colors. A click on a bulb shows the definition of `aircon.power.set` in that language (TypeScript, Python, Go, Rust or Pkl), with the helper that it uses, so that each language visibly sets the same input, failures and hints, highlighted by Shiki. The bulbs are buttons in a tab list, so the keyboard and the plain HTML fallback can change the language too. `updateElementGeometry` keeps hit testing on the HTML, so the reader can hover a surface screen to light its pipe. While three.js loads, the stage has the size of the machine and shows a soft glow, so the plain HTML does not flash before the machine appears, and the page does not move when it appears. The stage takes this state only after the page knows that the browser draws on a hardware GPU. Above 900px the machine is wide: the catalog screen on the left, the surface screens on the right. On narrower screens the same machine stands tall: the bulbs and the catalog screen on top, the surface screens stacked below, and the code wraps. When the reader asks for reduced motion, the machine is a still frame with a still camera: it is drawn again only when a screen changes, a bulb is clicked, hovered or focused, or a surface screen is hovered. Other browsers and software renderers show the plain HTML.
- **Fig. 2.** An SVG blueprint of the flow: Spec, Catalog, Core and Verify. It draws itself, and the parts move apart along their axis when it scrolls into sight. Beside it, `bluescreen.ts` draws the key specifications as a blue screen, with WebGPU or WebGL 2. When the reader asks for reduced motion, the blue screen is a still frame, drawn again only when its content changes or under the pointer. Browsers without HTML-in-Canvas, and software renderers, show the plain HTML.
- **Fig. 3.** A tab for each surface: the command line, the MCP server, WebMCP, the HTTP API and programmatic access. The selected tab shows a render of the surface, who uses it, what it does, an example and a link to its specification. Glass gauges fill and bubble when a tab is selected or under the pointer. Without JavaScript, all five panels show.
- **Fig. 4.** A console with a vertical tab for each core: TypeScript, Effect, Rust, and "Your own core", which shows how `acid-cat conform` tests a core in any other language. The code comes from the README of each core. With HTML-in-Canvas, `bluescreen.ts` draws the console as a calm blue screen that builds up from noise, and builds up again quickly when the reader changes the tab. The console keeps the width of the screen, so the text keeps its proportions at every width. With reduced motion, the screen is a still frame that changes with the tab. Other browsers and software renderers show the plain console.

## The hero buttons and the footer

"Get started" goes to `/docs/`. "Star on GitHub" goes to the repository. In the browser, it asks the GitHub API for the number of stars, and shows it in a badge on the button. When the request fails, the badge does not show.

The footer has one link column for each section of the header: Docs, Spec and Project. Each column has five links. Under the links, the large word AcidCat has a gradient of brass, acid green, cyan and Nixie amber.

## Agents

The site serves its own content to agents through AcidCat. `src/lib/agent/app.ts` defines an app with four read-only capabilities, all for the target `agents`:

| Capability | What it does |
| --- | --- |
| `site.pages.list` | List the pages of the site, or the pages of one section |
| `site.pages.read` | Give the content of one page of the site as Markdown |
| `site.pages.search` | Find the pages of the site that contain each word of a query |
| `site.packages.list` | List the packages that AcidCat publishes |

The capabilities read `/content.json`, which the build writes: each page with its Markdown, and each package. The Worker reads it through the assets binding, and the page reads it with `fetch`, so the Worker bundle has no content of the site.

| URL | What it serves |
| --- | --- |
| `/mcp` | The MCP server of the app, through `mcpHandler` and `mcpHandshake` of `@acid-cat/core-ts`. Its Server Card is at `/mcp/server-card` |
| `/api/` | The HTTP surface of the app: `GET /api/capabilities`, `POST /api/capabilities/{id}` and `GET /api/catalog`. `GET /api`, the anchor of the API Catalog, redirects to `/api/capabilities` |
| Each page | WebMCP tools, through `installWebMcp` of `@acid-cat/core-ts`, in a browser with WebMCP. Chromium has WebMCP with `--enable-features=WebMCP` |
| Each page, with `Accept: text/markdown` | The Markdown of the page, with `Content-Type: text/markdown` and `Vary: Accept`. A browser gets the HTML. Each page also has its Markdown at `<path>/index.md` |
| Each page that exists | A `Link` header (RFC 8288) to the API Catalog, the catalog of the HTTP API, the Server Card, the docs, `llms.txt`, the agent skills, the sitemap and the Markdown of the page |
| `/llms.txt`, `/llms-full.txt` | An index of the pages for language models, and the Markdown of every page in one file |
| `/.well-known/api-catalog` | The API Catalog of RFC 9727: the HTTP API and the MCP server, with their descriptions and docs |
| `/.well-known/mcp/server-card.json` | The Server Card of `/mcp/server-card` |
| `/.well-known/ai-catalog.json` | The AI Catalog of Agentic Resource Discovery: the MCP server and the agent skill. The identifier of the host is the origin of the site. The type of the skill is `application/gzip`, the media type that the Agent Skills Discovery RFC gives to a `.tar.gz` archive |
| `/.well-known/agent-skills/index.json` | The Agent Skills Discovery index (0.2.0). It lists the skill `skills/acid-cat` of the repository as a `.tar.gz` archive, with its SHA-256 digest. The build makes the archive from the files of the skill |

`src/lib/agent/files.ts` writes the Markdown of each page, `/content.json`, `llms.txt`, `llms-full.txt` and the agent skills after `vitepress build`. The Markdown of each page comes from its built HTML, so the components of the docs, such as the language tabs, keep their content. The homepage has its own Markdown, `src/lib/agent/home.md`.

## Roadmap

- [ ] Documentation content
