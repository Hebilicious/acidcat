# AcidCat site

The homepage and the documentation of AcidCat. The site uses [Astro](https://astro.build) and [Starlight](https://starlight.astro.build). It is a Moon project, and it is not published to a registry.

## Commands

| Command | Use |
| --- | --- |
| `moon run site:dev` | Serve the site with live reload at `http://localhost:4321`, and write the design tokens again each time `cssforge.config.ts` changes |
| `moon run site:tokens` | Write the design tokens from `cssforge.config.ts` into `.cssforge/output.css` |
| `moon run site:tokens-check` | Check that `.cssforge/output.css` matches `cssforge.config.ts`. `site:test` runs it |
| `moon run site:build` | Build the static site into `dist/` |
| `moon run site:test` | Test the geometry of the logo, check that every design token in use exists, and render the homepage in Chromium at desktop and phone widths |
| `moon run site:typecheck` | Type-check the geometry, the tests and the configuration |

## Structure

| Path | Contents |
| --- | --- |
| `src/pages/index.astro` | The homepage. It does not use the Starlight layout |
| `src/components/LivingPlate.astro` | The hero: the key art as a still image, and a WebGL canvas that brings it to life |
| `src/lib/plate-renderer.ts`, `src/lib/plate-shader.ts` | The WebGL 2 renderer and its shader |
| `src/components/Schematic.astro` | Fig. 1: one capability of the catalog, and the surface that each binding makes from it |
| `src/lib/holo.ts`, `src/lib/catalog-engine.ts`, `src/lib/engine-hardware.ts`, `src/lib/engine-finish.ts`, `src/lib/nixie-scene.ts` | Fig. 1 in 3D: worn brass screens, glass pipes and a rail of Nixie bulbs in three.js, with the HTML of each screen drawn by HTML-in-Canvas |
| `src/components/Blueprint.astro`, `src/components/Exploded.astro` | Fig. 1a: an animated blueprint of the flow Spec, Catalog, Runtime and Verify, and the key specifications on a blue screen |
| `public/parts/`, `art/parts/` | Fig. 2: renders of the four parts, and their source |
| `src/components/Surfaces.astro` | Fig. 3: the five surfaces, each with an example from its binding |
| `src/components/CoreScreens.astro`, `src/lib/bluescreen.ts` | Fig. 4: how to use each core, on a console drawn with HTML-in-Canvas |
| `src/lib/snippets.ts` | Reads the code examples from `examples/aircon` and the READMEs of the cores at build time, and highlights them with Shiki |
| `src/styles/code.css` | Maps the colors of the code to the palette |
| `src/components/Mark.astro`, `src/assets/mark.svg`, `public/favicon.svg`, `art/logo/` | The logo (a brass cat in profile), the favicon, and the explorations behind them |
| `src/lib/geometry.ts` | Pure functions that compute gears |
| `src/content/docs/docs/` | The Starlight documentation, served under `/docs/` |
| `cssforge.config.ts` | The design tokens: colors, fluid type and spacing scales, font families, tracking, radii and layout widths. [cssforge](https://github.com/Hebilicious/cssforge) writes them as CSS variables into `.cssforge/output.css`, which is committed |
| `src/styles/tokens.css` | Imports the design tokens and the fonts that the homepage and the documentation share |
| `public/hero/` | The hero textures. `art/pack.sh` writes them |
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

The renderer lowers its resolution when frames are slow, and shows a still frame when the device cannot keep up or renders WebGL in software. The still image shows when WebGL 2 is not available, and when the reader asks for reduced motion.

## The sections

- **Fig. 1.** In browsers that support [HTML-in-Canvas](https://github.com/WICG/html-in-canvas), `holo.ts` loads three.js and builds a machine of worn brass: the catalog screen, five surface screens, glass pipes with flowing acid, and a rail of six Nixie bulbs under the catalog screen. The text of each screen is live HTML in a `<canvas content="drawable">`. On each `paint` event, `texElementSubImage2D` copies the HTML of each screen into its texture, and a CRT shader draws it with its syntax colors. A click on a bulb shows the definition of `aircon.power.set` in that language (`{}` for the canonical JSON, then TypeScript, Python, Go, Rust and Pkl), highlighted by Shiki. The bulbs are buttons in a tab list, so the keyboard and the plain HTML fallback can change the language too. `updateElementGeometry` keeps hit testing on the HTML, so the reader can hover a surface screen to light its pipe. Other browsers, software renderers, narrow screens and reduced motion show the plain HTML.
- **Fig. 1a.** An SVG blueprint of the flow: Spec, Catalog, Runtime and Verify. It draws itself, and the parts move apart along their axis when it comes into view. Beside it, `bluescreen.ts` draws the key specifications as a blue screen.
- **Fig. 2.** The four parts as renders. They float, and the card under the pointer lifts them.
- **Fig. 3.** One card for each surface: the command line, the MCP server, WebMCP, the HTTP API and TypeScript. Each card tells what the surface is and who uses it, and shows an example from its binding.
- **Fig. 4.** A console with a tab for each core: TypeScript, Effect and Rust. The code comes from the README of the core. With HTML-in-Canvas, `bluescreen.ts` draws the console as a blue screen that builds up from noise, and builds up again when the reader changes the tab. Other browsers show the plain console.

## Roadmap

- [ ] Documentation content
- [ ] A production URL in `site` of `astro.config.ts`, for the sitemap and the canonical links
- [ ] Deployment
