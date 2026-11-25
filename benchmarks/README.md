# Benchmarks

This project measures what a reader sees on a documentation site. It compares vaporpress with VitePress, Astro Starlight and Nuxt Docus, in two suites:

- **fixture**: the same small docs site in each framework. It shows the defaults of each framework.
- **site**: the homepage and two docs pages of the AcidCat site, in its three builds: vaporpress (`moon run site:build`), VitePress (`main`, the site in production), and Astro Starlight (commit `fe26e301`). No Nuxt build of the AcidCat site exists.

The workflow [`benchmark.yml`](../.github/workflows/benchmark.yml) runs both suites on GitHub's runners. It writes the tables to the summary of the run, and uploads the raw results.

## What each measure means for a reader

| Measure | What the reader sees | How |
| --- | --- | --- |
| Performance score | The summary of Lighthouse for a first visit on a phone | Lighthouse 13.6.0, mobile, simulated throttling (slow 4G, 4× CPU slowdown) |
| First Contentful Paint (FCP) | The first text or image on screen | Lighthouse |
| Largest Contentful Paint (LCP) | The main content on screen | Lighthouse |
| Cumulative Layout Shift (CLS) | Content that jumps while the page loads | Lighthouse |
| Total Blocking Time (TBT) | Time when the page does not respond, because a script runs | Lighthouse |
| Speed Index | How fast the visible part of the page fills | Lighthouse |
| JavaScript transferred | The bytes of script that the first visit downloads, with Brotli | The `network-requests` audit of Lighthouse: the requests of type Script until the network is quiet. A chunk that a framework prefetches with `import()` counts here. A chunk that a framework prefetches with `<link rel="prefetch">` (VitePress) has the type Other, so it counts only in the total |
| JavaScript decoded | The bytes of script that the browser must read, without compression | The same requests, their size after decompression |
| Total transferred, requests | The full cost of the first visit on a metered connection | The same requests. Requests to other origins are counted apart |
| Ready | The time until a click works | From the start of the navigation, a probe clicks the second tab every 50 ms. The time of the first click that selects it. A click before that does nothing, so the probe does not change the page |
| Tab switch | The delay of a click on a tab | A real click on the third tab, from the press to the first paint that shows it selected |
| Search | The delay until the search field shows | A real click on the search button, from the press to the first paint that shows the field |
| Page change, cold | A click on a sidebar link, as soon as the page has loaded | From the press to the first paint with the `h1` of the new page. Only what the framework loaded before the click helps |
| Page change, prefetched | The same click, after the pointer rested on the link for 2 s | The framework had the time to load the next page ahead |
| Back | The Back button after the page change | From `history.back()` to the first paint with the `h1` of the first page |
| Page change loads, Back loads | Whether the page change keeps the document, loads a new one, or takes it from the back/forward cache | A token on `window` before the click, and the `pageshow` event |

The probes in the browser use Playwright and Chromium in a desktop window (1350 × 940), so that each framework shows its sidebar and its search button. DevTools slows the CPU 4× and the network to the slow 4G of Lighthouse (150 ms of latency, 1.6 Mbit/s). The probes do not intercept requests, because interception turns off the HTTP cache.

Each table cell is the median of all the runs of all the jobs, and between brackets the range from the first to the third quartile. The best median of each row is in bold.

## Fairness

- **One fixture.** [`fixture/`](fixture/) holds the ten pages as Markdown: a home page with text and one image, docs pages with headings, highlighted code blocks, a table, tabs, and long and short pages. [`src/prepare.ts`](src/prepare.ts) writes the pages of each app from it, and changes only what each framework writes differently: the tabs, the title, the paths of the links, and where the image goes. Each framework serves the image in its default way: vaporpress and Starlight convert it to WebP at build time and write its size.
- **The standard setup of each framework.** Each app uses the documented way of its framework for each feature, and no tuning for speed:

  | App | Setup | Tabs | Search |
  | --- | --- | --- | --- |
  | [`apps/framework`](apps/framework/) | vaporpress, with a layout written for the benchmark in the way that a vaporpress site builds one (`site/src/app/` of the AcidCat site is the model), Shiki for code | Static HTML from Markdown, made interactive with `onPageUpdated` | The index and the engine of vaporpress, in a dialog that the page loads when the pointer or the focus comes to the search button |
  | [`apps/vitepress`](apps/vitepress/) | VitePress 2 with its default theme | `::: code-group` | Local search |
  | [`apps/starlight`](apps/starlight/) | Astro and Starlight | `<Tabs>` in MDX | Pagefind |
  | [`apps/nuxt`](apps/nuxt/) | Nuxt, Nuxt Content and the Docus theme, statically generated with `nuxt generate` | `::code-group` | Docus search |

  The framework has no theme, so its app has a layout of its own. It has each feature that the three themes have, so the numbers compare like with like:

  | Feature | vaporpress | VitePress | Starlight | Docus |
  | --- | --- | --- | --- | --- |
  | Theme switch | A button: light or dark. The page follows the system until the reader chooses | A button: light or dark. The page follows the system until the reader chooses | A list: dark, light or auto | A button: light or dark. The page follows the system until the reader chooses |
  | No flash of the wrong theme | An inline script in the head | An inline script in the head | An inline script in the head | An inline script in the head |
  | Mobile menu | Yes | Yes | Yes | Yes |
  | Copy button on code blocks | Yes | Yes | Yes | Yes |
  | Search shortcut | Control+K and `/` | Control+K and `/` | Control+K and `/` | Control+K |
  | Search results | The section, the title, and an excerpt around the first match, with each match marked | The section and the title. An excerpt only in the detailed view, which is off by default | The page, its sections, and an excerpt of each, with each match marked | The section, the title, and an excerpt |
  | Arrow keys in the results | Yes | Yes | No: Tab moves between the result links | Yes |
  | Table of contents | Marks the heading of the section on screen | Marks the heading of the section on screen | Marks the heading of the section on screen | Marks the heading of the section on screen |
  | Table of contents on a phone | "On this page", which opens | "On this page", which opens | "On this page", which opens | "On this page", which opens |
  | Previous and next page | Yes | Yes | Yes | Yes, with the description of each page |
  | Skip link | Yes | Yes | Yes | No |
  | Arrow keys in the tabs | Yes | Yes: each tab is a radio button | Yes | Yes |
  | Web font | None: the font of the system | Inter, preloaded | None | None |
  | Other | — | — | — | "Copy page", with a menu that opens the page in AI assistants |

  The features of the vaporpress app are in `apps/framework/src/`. `test/framework-app.test.ts` checks each of them in Chromium, and runs every rule of axe-core on the pages in both themes, at desktop and phone widths, with the menu and the search open.
- **Pinned versions.** The pnpm catalog pins each version. The Nuxt app uses the stable Vue and the `rolldown` that Nuxt asks for, from the catalog `nuxt`. One build-only fix applies: an override gives Starlight satteri 0.11, the version that Astro uses. Without it, the build of a page with tabs crashes. The pages that it writes do not change.
- **One server.** [`src/server.ts`](src/server.ts) serves each build from memory in the same way: Brotli at quality 11 for text, compressed once before the first request; an ETag on each file; a year of cache for the hashed assets of the framework, and a check on each load for the rest. It is HTTP/1.1 on localhost.
- **One runner for each job.** Each job measures every build of its suite on the same runner, in turns: run 1 starts with the first build, run 2 with the second, and so on. Each Lighthouse run and each probe starts in a new browser context, with an empty cache. The `build` job builds once, and each measure job downloads the same files.
- **Medians over jobs.** Each suite runs in three jobs on three runners, with five runs in each job by default. The tables pool the fifteen samples.

## Run

On GitHub: run the workflow **Benchmark** (`gh workflow run benchmark.yml`), or push a change to `benchmarks/`. A pull request that changes `benchmarks/`, `vaporpress/src/` or the workflow runs it too. Read the tables in the summary of the run, or download the artifact `summary`.

On this machine, for a test of the probes, not for numbers to compare:

```sh
moon run benchmarks:fixture -- --runs 1
moon run benchmarks:summarize
```

`node src/run.ts --suite site --site-framework <folder> --site-vitepress <folder> --site-astro <folder>` measures three builds of the AcidCat site that you made.

| Option of `src/run.ts` | Use |
| --- | --- |
| `--suite` | `fixture` or `site` |
| `--runs` | Runs of each measure. The default is 5 |
| `--job` | The name of the job, in the name of its folder of results |
| `--out` | The folder of the results. The default is `results/` |

Each job writes `results/<suite>-<job>/results.json`, with each sample, and the Lighthouse report of each page of its first run. `src/summarize.ts` reads each `results.json` under `results/` and writes the tables.

## Tests

`moon run benchmarks:test` tests the transform of the fixture for each framework, the static server, and the statistics and the tables of the results. It builds the vaporpress app, and checks its features in Chromium: the theme before the first paint and the switch, the mobile menu, the copy button, the search with its excerpts and its keys, the table of contents, the previous and next pages, the keys of the tabs, and every rule of axe-core (`test/framework-app.test.ts`). It does not measure.

The framework app imports the framework as `framework`, an alias in [`apps/framework/package.json`](apps/framework/package.json). A new name of the framework changes that line, and the name of its Vite plugin in `apps/framework/vite.config.ts` when that name changes too.
