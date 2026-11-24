# AcidCat site

The homepage, the documentation, the specification and the list of packages of AcidCat. The site uses [Astro](https://astro.build) and [Starlight](https://starlight.astro.build). It is a Moon project, and it is not published to a registry.

## Commands

| Command | Use |
| --- | --- |
| `moon run site:dev` | Serve the site with live reload at `http://localhost:4321`, and write the design tokens again each time `cssforge.config.ts` changes |
| `moon run site:tokens` | Write the design tokens from `cssforge.config.ts` into `.cssforge/output.css` |
| `moon run site:tokens-check` | Check that `.cssforge/output.css` matches `cssforge.config.ts`. `site:test` runs it |
| `moon run site:build` | Build the static site into `dist/` |
| `moon run site:test` | Test the geometry of the logo, check that every design token in use exists, render the homepage in Chromium at desktop and phone widths, check that Fig. 1 keeps its height while it loads, compare the image of each GPU renderer with WebGPU and with WebGL 2, and check that the homepage stays in its budget of bytes on a phone (images, fonts, scripts and HTML), with no texture of the hero on a software renderer and no renderer code before its figure is near. Check that each page loads only files with a hash in their name, that the homepage loads no stylesheet and preloads each of its scripts, and that each page passes the accessibility rules of the Lighthouse audit "Accessibility tree is well-formed" (`test/delivery.test.ts`) |
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
| `src/lib/gpu/` | A full-screen shader pass for the hero and the blue screens. It draws with WebGPU when the browser gives a hardware adapter, and with WebGL 2 otherwise. Each shader is written once, in a subset of GLSL ES 3.00 that `shader.ts` gives to WebGL 2 and `wgsl.ts` translates to WGSL, so both backends draw the same image |
| `src/components/Schematic.astro` | Fig. 1: one capability of the catalog, and the surface that each binding makes from it |
| `src/lib/holo.ts`, `src/lib/catalog-engine.ts`, `src/lib/engine-hardware.ts`, `src/lib/engine-finish.ts`, `src/lib/engine-shader.ts`, `src/lib/nixie-scene.ts` | Fig. 1 in 3D: worn brass screens, glass pipes and a rail of Nixie bulbs in three.js, with the HTML of each screen drawn by HTML-in-Canvas. The custom materials are TSL node materials |
| `src/components/Blueprint.astro`, `src/components/Exploded.astro` | Fig. 2: an animated blueprint of the flow Spec, Catalog, Runtime and Verify, and the key specifications on a blue screen |
| `src/components/Surfaces.astro`, `src/assets/surfaces/`, `art/surfaces/` | Fig. 3: the five surfaces in tabs, each with a render, an example from its binding and a gauge |
| `src/components/CoreScreens.astro`, `src/lib/bluescreen.ts`, `src/lib/bluescreen-shader.ts` | Fig. 4: how to use each core, on a console drawn with HTML-in-Canvas |
| `src/lib/snippets.ts` | Reads the code examples from `examples/aircon` and the READMEs of the cores at build time, and highlights them with Shiki |
| `src/styles/code.css` | Maps the colors of the code to the palette |
| `src/components/Mark.astro`, `src/assets/mark.svg`, `src/assets/favicon.svg`, `art/logo/` | The logo (a brass cat in profile), the favicon, and the explorations behind them |
| `src/lib/geometry.ts` | Pure functions that compute gears |
| `src/content/docs/docs/` | The documentation, served under `/docs/` |
| `src/lib/ecosystem.ts` | The one list of catalog languages and cores. Every page and component that shows them reads it, the build fails when one has no example, and `test/ecosystem.test.ts` fails when it disagrees with `packages/` |
| `src/lib/catalog-examples.ts`, `src/components/docs/` | Read each definition of the aircon catalog from its five sources and its canonical JSON at build time, and show them in language tabs; tabs for the package managers of Node |
| `src/components/site/` | The header and the font preloads that the homepage and the docs share. Each page preloads only the faces that it uses, so the browser lays out the text once |
| `src/lib/external-links.ts` | Tells which links go to another website. A Markdown plugin in `astro.config.ts` opens them in a new tab, and `test/pages.test.ts` fails when a built page has an external link that does not |
| `src/route-middleware.ts` | Gives `/docs/` and `/spec/` their own sidebar |
| `src/lib/spec-diagrams.ts` | The SVG diagram that replaces the ASCII diagram of the specification |
| `src/lib/spec-pages.ts`, `src/content.config.ts` | Load each file of `spec/` into the docs collection at build time, served under `/spec/` |
| `src/pages/packages/index.astro`, `src/lib/packages.ts` | The list of published packages, served under `/packages/` |
| `src/lib/code-theme.ts`, `src/styles/starlight.css`, `src/components/starlight/` | The palette of the site in the docs: colors, fonts, code blocks, and the dark theme only |
| `cloudflare.config.ts` | The Worker that serves the site: its name, and the 404 page for unknown paths |
| `public/_headers` | The cache headers of the Worker. The files in `/_astro/` have a hash in their name, so the browser keeps them for a year. Each file that a page loads is in `/_astro/`: the images, the favicon and the fonts are imports, not files in `public/` |
| `src/lib/module-preload.ts` | Adds a `modulepreload` link at the top of the head of each page for each script that the page loads at once, and for each module that the script imports |
| `cssforge.config.ts` | The design tokens: colors, fluid type and spacing scales, font families, tracking, radii and layout widths. [cssforge](https://github.com/Hebilicious/cssforge) writes them as CSS variables into `.cssforge/output.css`, which is committed |
| `src/styles/tokens.css` | Imports the design tokens and the fonts that the homepage and the documentation share |
| `src/lib/fonts.ts` | Splits each font face into a small core file and the rest at build time, and writes their `@font-face` rules into `.fonts/` |
| `src/assets/hero/`, `src/lib/plate-crop.ts` | The hero textures, and the columns of the key art that the phone plates keep. `art/pack.sh` writes the textures |
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

`src/lib/fonts.ts` splits each face of Monaspace in two files when the build starts, and writes them with their `@font-face` rules into `.fonts/` (not in git). The core file has ASCII and the few other characters that the site uses, with all the OpenType features, at about half the size of the full face. The full face serves the other characters, with a `unicode-range`, so the browser downloads it only for a page that has one of them. `test/fonts.test.ts` fails when a page has a character outside the core: add it to `coreRanges`.

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

At 960px and below, the hero has a fixed aspect ratio, so it always shows the same columns of the key art. There, the `<picture>` gives a phone plate: the columns of `phoneCrop` in `src/lib/plate-crop.ts`, with a margin for the parallax, at 840, 1052 and 2104 pixels wide. The browser downloads less than half the bytes of the full plate, at the same resolution. The renderer maps the phone plate onto the key art with the uniform `uPlateRect`. When a resize across 960px gives the still image the other plate, the canvas goes away and the still image stays. The renderer loads the file that the browser chose for the still image from the `srcset`, so the browser downloads the plate once. It starts after the still image has loaded, so its textures do not take bandwidth from the LCP image.

The shader shifts the cat against the background with the depth map, as the pointer moves. Where the cat moves away, the clean plate shows. It also makes the eyes and the chest reactor pulse, sends light around the holographic rings, floats the brass bands, flickers the Nixie tubes, sparks the fibre optics, moves the plasma, steam and dust, and lights the brass where the pointer is. When the camera is still, the output is the key art.

The renderer uses WebGPU when the browser gives a hardware adapter, and WebGL 2 otherwise. It lowers its resolution when frames are slow. The still image stays when the browser renders in software, when neither WebGPU nor WebGL 2 is available, and when the reader asks for reduced motion. In these cases the page does not download the other textures of the hero.

The renderer checks the GPU before it downloads the textures. It decodes each texture into an `ImageBitmap` off the main thread, and it uploads the next texture only when the GPU has taken the one before it, so no upload blocks the main thread. The canvas has its final size before the renderer makes its context, so the drawing buffer is allocated once.

## Loading

- **Styles.** Astro writes the CSS of each page into its HTML (`build.inlineStylesheets`), so no stylesheet blocks the first render.
- **Scripts.** `src/lib/module-preload.ts` adds a `modulepreload` link for each script that a page loads at once, and for each module that the script imports. The browser fetches them all together with the HTML, and not one after the other.
- **Layout.** The sections under the hero, and the footer, have `content-visibility: auto`. The browser computes their style and their layout only when they come near the viewport, so the first layout of the page is short. Each section has an estimate of its height (`contain-intrinsic-size`), and the browser keeps its real height after the first layout.
- **Requests to other websites.** The number of stars on GitHub and the latest versions on the packages page load at low priority, so they do not take bandwidth from the page.
- **Cache.** Each file that a page loads has a hash in its name, so the browser keeps it for a year.

## The GPU renderers

The hero, Fig. 1 and the blue screens draw with WebGPU when `navigator.gpu` gives a hardware adapter (a low-power one, so that it shares the GPU of the compositor), and with WebGL 2 otherwise. Code for WebGPU and three.js loads only when a renderer needs it. Each shader has one source, so both backends draw the same image.

`src/lib/gpu/support.ts` tells whether the browser draws on a hardware GPU without blocking the main thread:

- **WebGPU.** The first device clears a texture of one pixel and reads it back. Some adapters give a device that draws nothing and reports no error until a read. When the read fails, the renderers use WebGL 2.
- **WebGL 2.** A worker makes a WebGL 2 context on an `OffscreenCanvas` and reads the name of the renderer. A name such as SwiftShader or llvmpipe is a software renderer. The worker stays open, because the main thread spends about 30 ms to release a worker that made a WebGL context.

Fig. 1, Fig. 2 and Fig. 4 start their renderer only when they come near the viewport, so none of them makes a context or loads its code while the page loads. The full-screen pass compiles its WebGL 2 shader in the background with `KHR_parallel_shader_compile`, and its WebGPU pipelines with `createRenderPipelineAsync`.

`test/gpu-parity.test.ts` renders the hero (after three seconds on a frozen clock), the wide and the tall Fig. 1, Fig. 2 and Fig. 4 (as still frames) with each backend in Chromium, and compares the pixels. Two images match when the mean difference of their channels is at most 1.5 of 255, and at most 0.5% of their pixels differ by more than 32 in a channel. The test needs a hardware GPU: it launches Chromium with `--enable-gpu --ignore-gpu-blocklist --use-gl=angle --use-angle=gl-egl --enable-unsafe-webgpu --enable-features=Vulkan --enable-blink-features=CanvasDrawElement`. On a machine with no hardware WebGPU or WebGL 2, such as CI, the test is skipped, and it prints the reason.

## The specification

The site does not copy the specification. At build time, `spec-pages.ts` reads each Markdown file of `spec/`, takes the first heading as the title, and rewrites the links: a link to another file of `spec/` goes to its page under `/spec/`, and a link to any other file of the repository goes to GitHub. `content.config.ts` adds these pages to the Starlight docs collection, so they have the sidebar, the search and the table of contents. In `site:dev`, a change to `spec/` loads the pages again.

## The packages

`/packages/` lists every package of `release-please-config.json`, so a package appears when its release is set up. The version on each card is the version in `.release-please-manifest.json`, and the description comes from the manifest of the package (`package.json`, `Cargo.toml`, `pyproject.toml`) or from `packages/README.md`. In the browser, the page asks each registry (npm, crates.io, PyPI, the Go module proxy, and the tags of the Pkl package on GitHub) for its latest version, and shows it.

## The sections

- **Fig. 1.** In browsers that support [HTML-in-Canvas](https://github.com/WICG/html-in-canvas), `holo.ts` loads the `WebGPURenderer` of three.js when the machine comes near the screen, and builds a machine of worn brass: the catalog screen, five surface screens, glass pipes with flowing acid, and a rail of five Nixie bulbs above the catalog screen. The text of each screen is live HTML in a `<canvas content="drawable">`. The renderer uses WebGPU when the browser gives a hardware adapter and `drawElementImageToTexture`, and WebGL 2 otherwise. The materials are written once in TSL, which three.js compiles to WGSL or to GLSL, so both backends draw the same machine. On each `paint` event, `drawElementImageToTexture` (WebGPU) or `texElementSubImage2D` (WebGL 2) copies the HTML of each screen into its texture, and a CRT shader draws it with its syntax colors. A click on a bulb shows the definition of `aircon.power.set` in that language (TypeScript, Python, Go, Rust or Pkl), with the helper that it uses, so that each language visibly sets the same input, failures and hints, highlighted by Shiki. The bulbs are buttons in a tab list, so the keyboard and the plain HTML fallback can change the language too. `updateElementGeometry` keeps hit testing on the HTML, so the reader can hover a surface screen to light its pipe. While three.js loads, the stage has the size of the machine and shows a soft glow, so the plain HTML does not flash before the machine appears, and the page does not move when it appears. The stage takes this state only after the page knows that the browser draws on a hardware GPU. Above 900px the machine is wide: the catalog screen on the left, the surface screens on the right. On narrower screens the same machine stands tall: the bulbs and the catalog screen on top, the surface screens stacked below, and the code wraps. When the reader asks for reduced motion, the machine is a still frame with a still camera: it is drawn again only when a screen changes, a bulb is clicked, hovered or focused, or a surface screen is hovered. Other browsers and software renderers show the plain HTML.
- **Fig. 2.** An SVG blueprint of the flow: Spec, Catalog, Runtime and Verify. It draws itself, and the parts move apart along their axis when it comes into view. Beside it, `bluescreen.ts` draws the key specifications as a blue screen, with WebGPU or WebGL 2. When the reader asks for reduced motion, the blue screen is a still frame, drawn again only when its content changes or under the pointer. Browsers without HTML-in-Canvas, and software renderers, show the plain HTML.
- **Fig. 3.** A tab for each surface: the command line, the MCP server, WebMCP, the HTTP API and programmatic access. The selected tab shows a render of the surface, who uses it, what it does, an example from its binding and a link to the binding. Glass gauges fill and bubble when a tab is selected or under the pointer. Without JavaScript, all five panels show.
- **Fig. 4.** A console with a vertical tab for each core: TypeScript, Effect, Rust, and "Your own core", which shows how `acid-cat conform` tests a core in any other language. The code comes from the README of each core. With HTML-in-Canvas, `bluescreen.ts` draws the console as a calm blue screen that builds up from noise, and builds up again quickly when the reader changes the tab. The console keeps the width of the screen, so the text keeps its proportions at every width. With reduced motion, the screen is a still frame that changes with the tab. Other browsers and software renderers show the plain console.

## The hero buttons and the footer

"Get started" goes to `/docs/`. "Star on GitHub" goes to the repository. In the browser, it asks the GitHub API for the number of stars, and shows it in a badge on the button. When the request fails, the badge does not show.

The footer has one link column for each section of the header: Docs, Spec and Project. Each column has five links. Under the links, the large word AcidCat has a gradient of brass, acid green, cyan and Nixie amber.

## Roadmap

- [ ] Documentation content
