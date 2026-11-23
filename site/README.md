# AcidCat site

The homepage and the documentation of AcidCat. The site uses [Astro](https://astro.build) and [Starlight](https://starlight.astro.build). It is a Moon project, and it is not published to a registry.

## Commands

| Command | Use |
| --- | --- |
| `moon run site:dev` | Serve the site with live reload at `http://localhost:4321` |
| `moon run site:colors` | Write the color variables from `cssforge.config.ts` into `.cssforge/output.css`. `dev` and `build` run it first |
| `moon run site:build` | Build the static site into `dist/` |
| `moon run site:test` | Test the geometry of the art, and render the homepage in Chromium at desktop and phone widths |
| `moon run site:typecheck` | Type-check the geometry, the tests and the configuration |

## Structure

| Path | Contents |
| --- | --- |
| `src/pages/index.astro` | The homepage. It does not use the Starlight layout |
| `src/components/LivingPlate.astro` | The hero: the key art as a still image, and a WebGL canvas that brings it to life |
| `src/lib/plate-renderer.ts`, `src/lib/plate-shader.ts` | The WebGL 2 renderer and its shader |
| `src/components/Schematic.astro` | One capability of the catalog, and the surface that each binding makes from it |
| `src/lib/holo.ts` | Draws the schematic as a hologram with HTML-in-Canvas, when the browser supports it |
| `src/components/Exploded.astro` | A blueprint of the four parts: catalog, bindings, core and `acid-cat conform` |
| `src/lib/geometry.ts` | Pure functions that compute the gear of the logo |
| `src/content/docs/docs/` | The Starlight documentation, served under `/docs/` |
| `cssforge.config.ts` | The color palette. [cssforge](https://github.com/Hebilicious/cssforge) writes it as CSS variables (`--palette-brass-400`) in OKLCH |
| `src/styles/tokens.css` | Imports the color variables, and sets the fonts that the homepage and the documentation share |
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

The CSS uses only the palette variables. For transparency, it mixes a variable with `transparent`: `color-mix(in oklch, var(--palette-acid-400) 40%, transparent)`.

The fonts are Fraunces for headings, Space Grotesk for text and JetBrains Mono for code and labels.

## The hero

`art/key-art.png` is the key art. The hero reproduces it, and makes it move. The textures come from these sources:

| File | What it is | Made by |
| --- | --- | --- |
| `key-art.png` | The key art, 1672×941 | Image generation |
| `key-art-wide.png` | The key art, extended 728 px to the left for the headline, 2400×941 | Image generation (outpainting). The right 1672 px are the pixels of `key-art.png` |
| `clean-plate-wide.png` | The scene without the cat, the pedestal and the rings | Image generation (inpainting). It is equal to `key-art-wide.png` outside `cut-mask-wide.png` |
| `cut-mask-wide.png` | The region that the clean plate replaces | The inpainting step, with the matte dilated |
| `depth-wide.png` | A depth map | `derive.py` (Depth Anything V2 Small, Apache-2.0) |
| `matte-wide.png` | The cat, the pedestal and the brass bands | `derive.py` on `key-art.png` (BiRefNet, MIT), padded to the wide size |
| `plate-wide@2x.png` | The wide key art at twice the size. Not in git | `derive.py` (Swin2SR, Apache-2.0) |

`uv run --script art/derive.py art/key-art-wide.png <directory>` writes the depth map, the matte and the large plate. It needs an NVIDIA GPU to run in a few minutes. `art/pack.sh` packs the depth, the matte and the cut mask into `public/hero/data.png`, and writes the plates as WebP.

The shader shifts the cat against the background with the depth map, as the pointer moves. Where the cat moves away, the clean plate shows. It also makes the eyes and the chest reactor pulse, sends light around the holographic rings, floats the brass bands, flickers the Nixie tubes, sparks the fibre optics, moves the plasma, steam and dust, and lights the brass where the pointer is. When the camera is still, the output is the key art.

The renderer lowers its resolution when frames are slow, and shows a still frame when the device cannot keep up or renders WebGL in software. The still image shows when WebGL 2 is not available, and when the reader asks for reduced motion.

## The hologram

In browsers that support [HTML-in-Canvas](https://github.com/WICG/html-in-canvas), `holo.ts` moves the schematic into a `<canvas content="drawable">`. The schematic stays live HTML: the reader can select its text, and the capsules react to the pointer. On each `paint` event, `texElementSubImage2D` copies the HTML into a WebGL texture, and a shader draws it as a hologram: it builds up from noise when it comes into view, and has scan lines, a scan beam, color fringes, glow, a projector line, and a lens that follows the pointer. `updateElementGeometry` keeps hit testing on the HTML. Other browsers, software renderers and reduced motion show the plain HTML.

## Roadmap

- [ ] Documentation content
- [ ] A production URL in `site` of `astro.config.ts`, for the sitemap and the canonical links
- [ ] Deployment
