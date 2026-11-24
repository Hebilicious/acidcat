# AcidCat site

The homepage, the documentation, the specification and the list of packages of AcidCat. The site uses [Astro](https://astro.build) and [Starlight](https://starlight.astro.build). It is a Moon project, and it is not published to a registry.

## Commands

| Command | Use |
| --- | --- |
| `moon run site:dev` | Serve the site with live reload at `http://localhost:4321`, and write the design tokens again each time `cssforge.config.ts` changes |
| `moon run site:tokens` | Write the design tokens from `cssforge.config.ts` into `.cssforge/output.css` |
| `moon run site:tokens-check` | Check that `.cssforge/output.css` matches `cssforge.config.ts`. `site:test` runs it |
| `moon run site:build` | Build the static site into `dist/` |
| `moon run site:test` | Test the geometry of the logo, check that every design token in use exists, and render the homepage in Chromium at desktop and phone widths |
| `moon run site:deploy` | Build the site and deploy it to https://acidcat.hebilicious.workers.dev as an assets-only Worker, with the `cf` command. Set `CLOUDFLARE_ACCOUNT_ID` first |
| `moon run site:typecheck` | Type-check the geometry, the tests and the configuration |

## Deployment

[Workers Builds](https://developers.cloudflare.com/workers/ci-cd/builds/) deploys the site when a commit reaches `main`. It is connected to the Worker `acidcat`, and it runs `bash site/scripts/cloudflare.sh build`, then `bash site/scripts/cloudflare.sh deploy`, from the root of the repository. The script installs proto, then Node, pnpm and Moon from `.prototools`, and runs `site:build` or `site:deploy`. Workers Builds gives `site:deploy` the account and the token. A build starts only when a commit changes a file that the build reads: `site/`, `spec/`, the release files, the package manifests and READMEs, the aircon catalog, and the files of the toolchain and the workspace.

## Structure

| Path | Contents |
| --- | --- |
| `src/pages/index.astro` | The homepage. It does not use the Starlight layout |
| `src/components/LivingPlate.astro` | The hero: the key art as a still image, and a canvas that brings it to life |
| `src/lib/plate-renderer.ts`, `src/lib/plate-shader.ts` | The renderer of the hero and its shader |
| `src/lib/gpu/` | A full-screen shader pass for the hero and the blue screens. It draws with WebGPU when the browser gives a hardware adapter, and with WebGL 2 otherwise. Each shader is written once, in a subset of GLSL ES 3.00 that `shader.ts` translates to WGSL, so both backends draw the same image |
| `src/components/Schematic.astro` | Fig. 1: one capability of the catalog, and the surface that each binding makes from it |
| `src/lib/holo.ts`, `src/lib/catalog-engine.ts`, `src/lib/engine-hardware.ts`, `src/lib/engine-finish.ts`, `src/lib/nixie-scene.ts` | Fig. 1 in 3D: worn brass screens, glass pipes and a rail of Nixie bulbs in three.js, with the HTML of each screen drawn by HTML-in-Canvas |
| `src/components/Blueprint.astro`, `src/components/Exploded.astro` | Fig. 2: an animated blueprint of the flow Spec, Catalog, Runtime and Verify, and the key specifications on a blue screen |
| `src/components/Surfaces.astro`, `public/surfaces/`, `art/surfaces/` | Fig. 3: the five surfaces in tabs, each with a render, an example from its binding and a gauge |
| `src/components/CoreScreens.astro`, `src/lib/bluescreen.ts`, `src/lib/bluescreen-shader.ts` | Fig. 4: how to use each core, on a console drawn with HTML-in-Canvas |
| `src/lib/snippets.ts` | Reads the code examples from `examples/aircon` and the READMEs of the cores at build time, and highlights them with Shiki |
| `src/styles/code.css` | Maps the colors of the code to the palette |
| `src/components/Mark.astro`, `src/assets/mark.svg`, `public/favicon.svg`, `art/logo/` | The logo (a brass cat in profile), the favicon, and the explorations behind them |
| `src/lib/geometry.ts` | Pure functions that compute gears |
| `src/content/docs/docs/` | The documentation, served under `/docs/` |
| `src/lib/ecosystem.ts` | The one list of catalog languages and cores. Every page and component that shows them reads it, the build fails when one has no example, and `test/ecosystem.test.ts` fails when it disagrees with `packages/` |
| `src/lib/catalog-examples.ts`, `src/components/docs/` | Read each definition of the aircon catalog from its five sources and its canonical JSON at build time, and show them in language tabs; tabs for the package managers of Node |
| `src/components/site/` | The header and the font preloads that the homepage and the docs share |
| `src/lib/external-links.ts` | Tells which links go to another website. A Markdown plugin in `astro.config.ts` opens them in a new tab, and `test/pages.test.ts` fails when a built page has an external link that does not |
| `src/route-middleware.ts` | Gives `/docs/` and `/spec/` their own sidebar |
| `src/lib/spec-diagrams.ts` | The SVG diagram that replaces the ASCII diagram of the specification |
| `src/lib/spec-pages.ts`, `src/content.config.ts` | Load each file of `spec/` into the docs collection at build time, served under `/spec/` |
| `src/pages/packages/index.astro`, `src/lib/packages.ts` | The list of published packages, served under `/packages/` |
| `src/lib/code-theme.ts`, `src/styles/starlight.css`, `src/components/starlight/` | The palette of the site in the docs: colors, fonts, code blocks, and the dark theme only |
| `cloudflare.config.ts` | The Worker that serves the site: its name, and the 404 page for unknown paths |
| `cssforge.config.ts` | The design tokens: colors, fluid type and spacing scales, font families, tracking, radii and layout widths. [cssforge](https://github.com/Hebilicious/cssforge) writes them as CSS variables into `.cssforge/output.css`, which is committed |
| `src/styles/tokens.css` | Imports the design tokens and the fonts that the homepage and the documentation share |
| `public/hero/` | The hero textures. `art/pack.sh` writes them |
| `src/lib/social.ts`, `public/og/`, `art/og/build.sh` | The Open Graph and Twitter card of each section (home, docs, spec, packages). `art/og/build.sh` writes the 1200 by 630 images from the key art, the logo and the Monaspace fonts; `test/pages.test.ts` fails when a page has no card |
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

The fonts are from [Monaspace](https://monaspace.githubnext.com/): Xenon for headings, Radon for the accent words in headings, Argon for text, Krypton for labels and Neon for code. Texture healing (`calt`) is on. cssforge has no Vite plugin, so `site:dev` runs `cssforge --watch` next to Astro.

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
| `plate-wide@2x.png` | The wide key art at twice the size. Not in git | `derive.py` (Swin2SR, Apache-2.0) |

`uv run --script art/derive.py art/key-art-wide.png <directory>` writes the depth map, the matte and the large plate. It needs an NVIDIA GPU to run in a few minutes. `art/pack.sh` packs the depth, the matte and the cut mask into `public/hero/data.png`, and writes the plates as WebP.

The shader shifts the cat against the background with the depth map, as the pointer moves. Where the cat moves away, the clean plate shows. It also makes the eyes and the chest reactor pulse, sends light around the holographic rings, floats the brass bands, flickers the Nixie tubes, sparks the fibre optics, moves the plasma, steam and dust, and lights the brass where the pointer is. When the camera is still, the output is the key art.

The renderer uses WebGPU when the browser gives a hardware adapter, and WebGL 2 otherwise. It lowers its resolution when frames are slow, and shows a still frame when the device cannot keep up or renders in software. The still image shows when neither WebGPU nor WebGL 2 is available, and when the reader asks for reduced motion.

## The specification

The site does not copy the specification. At build time, `spec-pages.ts` reads each Markdown file of `spec/`, takes the first heading as the title, and rewrites the links: a link to another file of `spec/` goes to its page under `/spec/`, and a link to any other file of the repository goes to GitHub. `content.config.ts` adds these pages to the Starlight docs collection, so they have the sidebar, the search and the table of contents. In `site:dev`, a change to `spec/` loads the pages again.

## The packages

`/packages/` lists every package of `release-please-config.json`, so a package appears when its release is set up. The version on each card is the version in `.release-please-manifest.json`, and the description comes from the manifest of the package (`package.json`, `Cargo.toml`, `pyproject.toml`) or from `packages/README.md`. In the browser, the page asks each registry (npm, crates.io, PyPI, the Go module proxy, and the tags of the Pkl package on GitHub) for its latest version, and shows it.

## The sections

- **Fig. 1.** In browsers that support [HTML-in-Canvas](https://github.com/WICG/html-in-canvas), `holo.ts` loads three.js and builds a machine of worn brass: the catalog screen, five surface screens, glass pipes with flowing acid, and a rail of five Nixie bulbs above the catalog screen. The text of each screen is live HTML in a `<canvas content="drawable">`. On each `paint` event, `texElementSubImage2D` copies the HTML of each screen into its texture, and a CRT shader draws it with its syntax colors. A click on a bulb shows the definition of `aircon.power.set` in that language (TypeScript, Python, Go, Rust or Pkl), with the helper that it uses, so that each language visibly sets the same input, failures and hints, highlighted by Shiki. The bulbs are buttons in a tab list, so the keyboard and the plain HTML fallback can change the language too. `updateElementGeometry` keeps hit testing on the HTML, so the reader can hover a surface screen to light its pipe. While three.js loads, the stage keeps its size and shows a soft glow, so the plain HTML does not flash before the machine appears. Above 900px the machine is wide: the catalog screen on the left, the surface screens on the right. On narrower screens the same machine stands tall: the bulbs and the catalog screen on top, the surface screens stacked below, and the code wraps. Other browsers, software renderers and reduced motion show the plain HTML.
- **Fig. 2.** An SVG blueprint of the flow: Spec, Catalog, Runtime and Verify. It draws itself, and the parts move apart along their axis when it comes into view. Beside it, `bluescreen.ts` draws the key specifications as a blue screen, with WebGPU or WebGL 2. When the reader asks for reduced motion, the blue screen is a still frame, drawn again only when its content changes or under the pointer. Browsers without HTML-in-Canvas, and software renderers, show the plain HTML.
- **Fig. 3.** A tab for each surface: the command line, the MCP server, WebMCP, the HTTP API and programmatic access. The selected tab shows a render of the surface, who uses it, what it does, an example from its binding and a link to the binding. Glass gauges fill and bubble when a tab is selected or under the pointer. Without JavaScript, all five panels show.
- **Fig. 4.** A console with a vertical tab for each core: TypeScript, Effect, Rust, and "Your own core", which shows how `acid-cat conform` tests a core in any other language. The code comes from the README of each core. With HTML-in-Canvas, `bluescreen.ts` draws the console as a calm blue screen that builds up from noise, and builds up again quickly when the reader changes the tab. The console keeps the width of the screen, so the text keeps its proportions at every width. With reduced motion, the screen is a still frame that changes with the tab. Other browsers and software renderers show the plain console.

## The hero buttons and the footer

"Get started" goes to `/docs/`. "Star on GitHub" goes to the repository. In the browser, it asks the GitHub API for the number of stars, and shows it in a badge on the button. When the request fails, the badge does not show.

The footer has one link column for each section of the header: Docs, Spec and Project. Each column has five links. Under the links, the large word AcidCat has a gradient of brass, acid green, cyan and Nixie amber.

## Roadmap

- [ ] Documentation content
