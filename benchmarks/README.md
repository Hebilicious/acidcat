# Benchmarks

This project measures what a reader sees on a documentation site. It compares vaporpress with VitePress, Astro Starlight and Nuxt Docus, in two suites:

- **fixture**: the same small docs site in each framework. It shows the defaults of each framework.
- **site**: the homepage and two docs pages of the AcidCat site, in its three builds: vaporpress (`moon run site:build`), VitePress (commit `c2eb27d3`, the last build of the site with VitePress), and Astro Starlight (commit `fe26e301`). No Nuxt build of the AcidCat site exists.

The workflow [`benchmark.yml`](../.github/workflows/benchmark.yml) runs both suites on GitHub's runners. It writes the tables to the summary of the run, and uploads the raw results.

## What each measure means for a reader

| Measure | What the reader sees | How |
| --- | --- | --- |
| Performance score | The summary of Lighthouse for a first visit on a phone | Lighthouse 13.6.0, mobile, simulated throttling (slow 4G, 4× CPU slowdown) |
| First Contentful Paint (FCP), simulated | The first text or image on screen, on a slow phone | Lighthouse, simulated |
| Largest Contentful Paint (LCP), simulated | The main content on screen, on a slow phone | Lighthouse, simulated |
| First Contentful Paint, observed | The first text or image on screen, on the runner | `observedFirstContentfulPaint` of the Lighthouse report: the time in the trace of the load |
| Largest Contentful Paint, observed | The main content on screen, on the runner | `observedLargestContentfulPaint` of the Lighthouse report |
| Cumulative Layout Shift (CLS) | Content that jumps while the page loads | Lighthouse |
| Total Blocking Time (TBT), simulated | Time when the page does not respond, because a script runs | Lighthouse, simulated |
| Speed Index, simulated | How fast the visible part of the page fills | Lighthouse, simulated |
| JavaScript transferred | The bytes of script that the first visit downloads, with Brotli | The `network-requests` audit of Lighthouse: the requests of type Script until the network is quiet. A chunk that a framework prefetches with `import()` counts here. A chunk that a framework prefetches with `<link rel="prefetch">` (VitePress) has the type Other, so it counts only in the total |
| JavaScript decoded | The bytes of script that the browser must read, without compression | The same requests, their size after decompression |
| Total transferred, requests | The full cost of the first visit on a metered connection | The same requests. Requests to other origins are counted apart |
| Tab responds | The time until a click on a tab works | From the start of the navigation, a probe clicks the second tab every 50 ms. The time of the first click that selects it. A click before that does nothing, so the probe does not change the page. A site can make its tabs work before its other scripts: the AcidCat site on vaporpress runs a small inline script for them, so this row does not tell when the rest of the page responds |
| Search button responds | The time until the search button works | From the start of the navigation, a probe clicks the search button every 50 ms. The time of the first paint that shows the search field. The fixture and the AcidCat site on vaporpress have the closed dialog in their HTML, and a small inline script opens it before the app hydrates. Astro and Starlight also have the dialog in the HTML. In VitePress and Docus, the search button needs the scripts of the framework, and the time includes the code of the dialog when the app loads it on the first click |
| Tab switch | The delay of a click on a tab | A real click on the third tab, from the press to the first paint that shows it selected |
| Search | The delay until the search field shows | A real click on the search button, from the press to the first paint that shows the field |
| Page change, cold | A click on a sidebar link, as soon as the page has loaded | From the press to the first paint with the `h1` of the new page. Only what the framework loaded before the click helps |
| Page change, prefetched | The same click, after the pointer rested on the link for 2 s | The framework had the time to load the next page ahead |
| Back | The Back button after the page change | From `history.back()` to the first paint with the `h1` of the first page |
| Page change loads, Back loads | Whether the page change keeps the document, loads a new one, or takes it from the back/forward cache | A token on `window` before the click, and the `pageshow` event |

Lighthouse loads the page on the runner with no throttling, and computes the simulated values from the trace of that load: it models a slow phone (slow 4G, 4× CPU) with the requests and the tasks that it saw. A simulated value can change with the order of the tasks in the trace, also when a reader on the runner sees no difference; an observed value is what the runner showed, on a fast computer. Read the two together: a difference in both is a difference that a person sees.

The probes in the browser use Playwright and Chromium in a desktop window (1350 × 940), so that each framework shows its sidebar and its search button. DevTools slows the CPU 4× and the network to the slow 4G of Lighthouse (150 ms of latency, 1.6 Mbit/s). The probes do not intercept requests, because interception turns off the HTTP cache.

Each table cell is the median of all the runs of all the jobs, and between brackets the range from the first to the third quartile. The best median of each row is in bold.

## Fairness

- **One fixture.** [`fixture/`](fixture/) holds the ten pages as Markdown: a home page with text and one image, docs pages with headings, highlighted code blocks, a table, tabs, and long and short pages. [`src/prepare.ts`](src/prepare.ts) writes the pages of each app from it, and changes only what each framework writes differently: the tabs, the title, the paths of the links, and where the image goes. Each framework serves the image in its default way: vaporpress and Starlight convert it to WebP at build time and write its size.
- **The standard setup of each framework.** Each app uses the documented way of its framework for each feature, and no tuning for speed:

  | App | Setup | Tabs | Search |
  | --- | --- | --- | --- |
  | [`apps/framework`](apps/framework/) | vaporpress, with a layout written for the benchmark in the way that a vaporpress site builds one (`site/src/app/` of the AcidCat site is the model), Shiki for code | Static HTML from Markdown, made interactive with `onPageUpdated` | The index and the engine of vaporpress, in a dialog that is in the HTML of each page. An inline script opens it before the app hydrates, with `openDialogOnInput` of `vaporpress/behaviors` |
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
  | Search shortcut | Control+K and `/` | Control+K and `/` | Control+K | Control+K |
  | Search results | The section, the title, and an excerpt around the first match, with each match marked | The section and the title. An excerpt only in the detailed view, which is off by default | The page, its sections, and an excerpt of each, with each match marked | The section, the title, and an excerpt |
  | Arrow keys in the results | Yes | Yes | No: Tab moves between the result links | Yes |
  | Table of contents | Marks the heading of the section on screen | Marks the heading of the section on screen, from the first heading that reaches the top | Marks the heading of the section on screen | Marks each heading whose section is on screen |
  | Table of contents on a phone | "On this page", which opens | "On this page", which opens | "On this page", which opens | "On this page", which opens |
  | Previous and next page | Yes | Yes | Yes | Yes, with the description of each page |
  | Skip link | Yes | Yes | Yes | No |
  | Arrow keys in the tabs | Yes | Yes: each tab is a radio button | Yes | Yes |
  | Web font | None: the font of the system | Inter, preloaded | None | None |
  | Other | — | — | — | "Copy page", with a menu that opens the page in AI assistants; "Edit this page" and "Report an issue" |

  Each cell comes from the built apps, in Chromium at 1350 × 940: the keys pressed on the page, the controls on screen, and the table of contents before and after a scroll. The features of the vaporpress app are in `apps/framework/src/`. The app takes the logic of its tabs, its copy buttons, its table of contents and the keys of its search from `vaporpress/behaviors`, and keeps its own markup and styles. `test/framework-app.test.ts` checks each of its features in Chromium, and runs every rule of axe-core, the enhanced contrast too, on the pages in both themes, at desktop and phone widths, with the menu and the search open.
- **Pinned versions.** The pnpm catalog pins each version. The Nuxt app uses the stable Vue and the `rolldown` that Nuxt asks for, from the catalog `nuxt`. One build-only fix applies: an override gives Starlight satteri 0.11, the version that Astro uses. Without it, the build of a page with tabs crashes. The pages that it writes do not change.
- **One server.** [`src/server.ts`](src/server.ts) serves each build from memory in the same way: Brotli at quality 11 for text, compressed once before the first request; an ETag on each file; a year of cache for the hashed assets of the framework, and a check on each load for the rest. It is HTTP/1.1 on localhost.
- **One runner for each job.** Each job measures every build of its suite on the same runner, in turns: run 1 starts with the first build, run 2 with the second, and so on. Each Lighthouse run and each probe starts in a new browser context, with an empty cache. The `build` job builds once, and each measure job downloads the same files.
- **Medians over jobs.** Each suite runs in three jobs on three runners, with five runs in each job by default. The tables pool the fifteen samples.

## Results

The tables below pool four runs of the workflow on commit `9dcf013c`, 3 jobs each for each suite: [45742673507](https://github.com/Hebilicious/acidcat/actions/runs/45742673507), [45742736206](https://github.com/Hebilicious/acidcat/actions/runs/45742736206), [45745028813](https://github.com/Hebilicious/acidcat/actions/runs/45745028813) and [45746518501](https://github.com/Hebilicious/acidcat/actions/runs/45746518501). Their artifacts keep the raw results. The commits that write these tables change no code that the measures load.

Where vaporpress is not the best:

- **Script weight, in every first visit.** On the fixture, vaporpress transfers 44.0–44.6 kB of script (126–127 kB decoded), and Starlight 26.9–28.2 kB (106–108 kB). On the AcidCat site, vaporpress transfers 59.4–62.3 kB (166–167 kB decoded), VitePress 51.1–60.5 kB, and Astro 16.7–29.1 kB.
- **Total transfer and requests on the AcidCat site.** On all three routes, vaporpress transfers the most and makes the most requests: the homepage 370.5 kB and 34 requests (VitePress 361.3 kB and 25, Astro 294.9 kB and 21), the quick start 303.0 kB and 31 (283.3 and 21, 254.1 and 19), the catalog 296.9 kB and 31 (277.3 and 21, 246.3 and 19). On the fixture, Starlight transfers less on the homepage (51.6 kB, against 55.2 kB) and on `routing` (50.2 kB, against 51.1 kB).
- **The homepage of the AcidCat site.** The performance score is 93, against 95 for VitePress and 93 for Astro. Simulated: FCP and Speed Index 1,570 ms, against 795 and 820 ms for Astro and 817 and 854 ms for VitePress; LCP 3,162 ms, against 2,714 ms for Astro and 3,010 ms for VitePress. Observed first paint: 120 ms, against 118 ms for VitePress. TBT: 28 ms, against 20 ms for VitePress.
- **The docs pages of the AcidCat site.** Simulated Speed Index: 1,006 ms on the quick start and 977 ms on the catalog, against 797 ms for Astro. Observed first paint: 103 ms on the quick start and 99 ms on the catalog, against 100 and 86 ms for VitePress. TBT of the quick start: 3 ms, against 0 ms for VitePress.
- **The first paint of the fixture.** Observed, Starlight paints first on each page (40–42 ms, against 45–50 ms for vaporpress). Simulated, VitePress paints first on `installation` and `routing` (646 and 656 ms, against 751 ms), with a wide spread (634–1,115 ms), and Starlight paints the homepage 1 ms earlier (751 ms, against 752 ms for FCP and Speed Index).
- **Tab switch on the AcidCat site**: 50 ms, against 36 ms for VitePress.

vaporpress is the best, or tied, on the other rows: the scores of the docs pages and of the fixture, CLS, the requests of the fixture, when a tab and the search button respond, the search field, and the page changes and Back in both suites.

**Search before hydration.** On vaporpress, the search dialog is in the HTML of each page, and a small inline script opens it before the app hydrates (see [A control that answers before hydration](../vaporpress/README.md#a-control-that-answers-before-hydration)). On the AcidCat site, the search button responds after 414 ms, against 1,697 ms for Astro and 2,340 ms for VitePress, and the search field shows 66 ms after a press. Four runs of the same workflow on `main` at `672eb8d0`, before this behavior ([45721115411](https://github.com/Hebilicious/acidcat/actions/runs/45721115411), [45723908094](https://github.com/Hebilicious/acidcat/actions/runs/45723908094), [45745017060](https://github.com/Hebilicious/acidcat/actions/runs/45745017060) and [45746846747](https://github.com/Hebilicious/acidcat/actions/runs/45746846747)), give 2,412 ms and 82 ms.

**Rows where the AcidCat site on vaporpress is slower than on `main`:**

- **Tab responds**: 262 ms, against 231 ms. The HTML before the first tab of the quick start has 1.7 kB more with Brotli: the closed dialog, its CSS and the inline script of the search. At slow 4G, this is about 8 ms. The probe clicks every 50 ms, and the main thread starts the scripts of the page soon after the first paint, so a tab that is ready a few milliseconds later can answer one click later.
- **The page changes and Back**: 144, 109 and 85 ms, against 118, 93 and 71 ms. The runners of these runs were slower: on the same jobs, Astro takes 279, 269 and 279 ms, against 255, 247 and 222 ms in the runs of `main`. On jobs where Astro takes 250 to 280 ms, vaporpress takes 112 to 130 ms on `main` and 128 to 145 ms on this commit.

### The same fixture in each framework

12 jobs × 5 runs = 60 samples for each cell: the median, and the first to the third quartile. Lighthouse 13.6.0, Chromium 158.0.8127.18. The best median of each row is in bold.

A simulated value is what Lighthouse computes for a slow phone (slow 4G, 4× CPU) from the trace of the load. An observed value is in the trace itself: the runner loads the page with no throttling.

#### First visit: `home`, Lighthouse on mobile

| Metric | vaporpress | vitepress | starlight | docus |
| --- | --- | --- | --- | --- |
| Performance score | **100 (100–100)** | 97 (97–97) | **100 (100–100)** | 74 (71–75) |
| First Contentful Paint, simulated (ms) | 752 (752–753) | 1091 (633–1102) | **751 (751–752)** | 1009 (979–1039) |
| Largest Contentful Paint, simulated (ms) | **1352 (1352–1353)** | 2555 (2554–2557) | **1352 (1352–1353)** | 5896 (5422–6329) |
| First Contentful Paint, observed (ms) | 50 (36–65) | 79 (68–91) | **42 (32–55)** | 123 (102–144) |
| Largest Contentful Paint, observed (ms) | **57 (45–72)** | 79 (68–91) | 63 (55–78) | 163 (138–191) |
| Cumulative Layout Shift | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | 0.077 (0.077–0.077) |
| Total Blocking Time, simulated (ms) | **0 (0–4)** | 10 (4–29) | **0 (0–0)** | 225 (153–318) |
| Speed Index, simulated (ms) | 752 (752–753) | 1091 (653–1102) | **751 (751–752)** | 1010 (979–1040) |
| JavaScript transferred (Brotli) (kB) | 44.6 (44.6–44.6) | 62.2 (62.2–62.2) | **26.9 (26.9–26.9)** | 360.2 (360.2–360.4) |
| JavaScript decoded (kB) | 125.7 (125.7–125.7) | 190.3 (190.3–190.3) | **105.6 (105.6–105.6)** | 1246.4 (1246.4–1246.4) |
| Total transferred (kB) | 55.2 (55.2–55.2) | 284.3 (284.3–284.3) | **51.6 (51.6–51.6)** | 1115.9 (1115.9–1116.1) |
| Requests | **8 (8–8)** | 11 (11–11) | 10 (10–10) | 216 (216–216) |
| Requests to other origins | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** |

#### First visit: `installation`, Lighthouse on mobile

| Metric | vaporpress | vitepress | starlight | docus |
| --- | --- | --- | --- | --- |
| Performance score | **100 (100–100)** | **100 (100–100)** | **100 (100–100)** | 97 (94–99) |
| First Contentful Paint, simulated (ms) | 751 (751–752) | **646 (634–1102)** | 903 (902–904) | 1018 (960–1058) |
| Largest Contentful Paint, simulated (ms) | 751 (751–752) | **647 (634–1103)** | 1353 (1055–1355) | 1018 (960–1058) |
| First Contentful Paint, observed (ms) | 45 (35–56) | 72 (58–87) | **42 (31–52)** | 167 (140–197) |
| Largest Contentful Paint, observed (ms) | **45 (35–56)** | 72 (58–87) | 62 (52–71) | 167 (140–197) |
| Cumulative Layout Shift | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** |
| Total Blocking Time, simulated (ms) | **0 (0–3)** | 15 (6–34) | **0 (0–0)** | 202 (146–297) |
| Speed Index, simulated (ms) | **751 (751–752)** | 793 (641–1102) | 903 (902–904) | 1172 (1124–1250) |
| JavaScript transferred (Brotli) (kB) | 44.0 (44.0–44.0) | 61.5 (61.5–61.5) | **28.2 (28.2–28.2)** | 323.7 (323.7–323.9) |
| JavaScript decoded (kB) | 125.5 (125.5–125.5) | 189.5 (189.5–189.5) | **108.1 (108.1–108.1)** | 1148.8 (1148.8–1148.8) |
| Total transferred (kB) | **50.1 (50.1–50.1)** | 155.1 (155.1–155.1) | 50.2 (50.2–50.2) | 954.3 (954.2–954.3) |
| Requests | **7 (7–7)** | 9 (9–9) | 11 (11–11) | 224 (224–224) |
| Requests to other origins | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** |

#### First visit: `routing`, Lighthouse on mobile

| Metric | vaporpress | vitepress | starlight | docus |
| --- | --- | --- | --- | --- |
| Performance score | **100 (100–100)** | **100 (100–100)** | **100 (100–100)** | 96 (93–98) |
| First Contentful Paint, simulated (ms) | 751 (751–752) | **656 (643–1115)** | 903 (902–904) | 1039 (992–1080) |
| Largest Contentful Paint, simulated (ms) | 751 (751–752) | **656 (643–1115)** | 1353 (1057–1355) | 1042 (997–1083) |
| First Contentful Paint, observed (ms) | 50 (39–61) | 82 (63–97) | **40 (31–54)** | 173 (141–206) |
| Largest Contentful Paint, observed (ms) | **50 (39–61)** | 82 (63–97) | 62 (52–75) | 173 (141–206) |
| Cumulative Layout Shift | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** |
| Total Blocking Time, simulated (ms) | **0 (0–3)** | 24 (6–48) | **0 (0–0)** | 225 (151–324) |
| Speed Index, simulated (ms) | 751 (751–752) | **657 (643–1115)** | 903 (902–904) | 1131 (1090–1212) |
| JavaScript transferred (Brotli) (kB) | 44.3 (44.3–44.3) | 61.6 (61.6–61.6) | **28.2 (28.2–28.2)** | 323.8 (323.8–323.9) |
| JavaScript decoded (kB) | 126.7 (126.7–126.7) | 189.5 (189.5–189.5) | **108.1 (108.1–108.1)** | 1143.6 (1143.6–1143.6) |
| Total transferred (kB) | 51.1 (51.1–51.1) | 155.9 (155.9–155.9) | **50.2 (50.2–50.2)** | 956.6 (956.6–956.7) |
| Requests | **7 (7–7)** | 9 (9–9) | 11 (11–11) | 228 (228–228) |
| Requests to other origins | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** |

#### In the browser: desktop window, 4× CPU slowdown, slow 4G

| Metric | vaporpress | vitepress | starlight | docus |
| --- | --- | --- | --- | --- |
| Tab responds: navigation start to the first click that selects a tab (ms) | **627 (622–648)** | 1128 (1108–1171) | 666 (656–681) | 3181 (3148–3264) |
| Search button responds: navigation start to the search field on screen, with a click every 50 ms (ms) | **389 (386–397)** | 1485 (1458–1539) | 910 (872–944) | 4188 (4104–4301) |
| Tab switch: press to paint (ms) | **26 (26–27)** | 27 (27–28) | **26 (26–27)** | 38 (33–44) |
| Search: press to search field on screen (ms) | **30 (29–31)** | 311 (305–317) | 48 (44–53) | 254 (211–282) |
| Page change, cold: press to new page on screen (ms) | **161 (151–163)** | 162 (138–171) | 279 (265–295) | 376 (339–415) |
| Page change, link prefetched (ms) | **31 (30–33)** | 52 (50–59) | 273 (264–291) | 555 (526–579) |
| Back: call to previous page on screen (ms) | **26 (22–32)** | 39 (33–41) | 104 (93–121) | 168 (153–195) |
| Page change loads | same document (60/60) | same document (60/60) | new document (60/60) | same document (60/60) |
| Back loads | same document (60/60) | same document (60/60) | new document (60/60) | same document (60/60) |

### The AcidCat site

12 jobs × 5 runs = 60 samples for each cell: the median, and the first to the third quartile. Lighthouse 13.6.0, Chromium 158.0.8127.18. The best median of each row is in bold.

A simulated value is what Lighthouse computes for a slow phone (slow 4G, 4× CPU) from the trace of the load. An observed value is in the trace itself: the runner loads the page with no throttling.

#### First visit: `home`, Lighthouse on mobile

| Metric | vaporpress | vitepress (c2eb27d3) | astro (fe26e301) |
| --- | --- | --- | --- |
| Performance score | 93 (93–93) | **95 (94–95)** | 93 (92–94) |
| First Contentful Paint, simulated (ms) | 1570 (814–1585) | 817 (795–1559) | **795 (765–929)** |
| Largest Contentful Paint, simulated (ms) | 3162 (3161–3164) | 3010 (3007–3015) | **2714 (2711–2719)** |
| First Contentful Paint, observed (ms) | 120 (109–128) | **118 (105–129)** | 161 (151–169) |
| Largest Contentful Paint, observed (ms) | 120 (109–128) | **118 (105–129)** | 161 (151–169) |
| Cumulative Layout Shift | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** |
| Total Blocking Time, simulated (ms) | 28 (16–42) | **20 (15–38)** | 207 (148–234) |
| Speed Index, simulated (ms) | 1570 (1193–1585) | 854 (795–1559) | **820 (794–932)** |
| JavaScript transferred (Brotli) (kB) | 62.3 (62.3–62.3) | 60.5 (60.5–60.5) | **16.7 (16.7–16.7)** |
| JavaScript decoded (kB) | 165.7 (165.7–165.7) | 167.4 (167.4–167.4) | **34.7 (34.7–34.7)** |
| Total transferred (kB) | 370.5 (370.5–370.5) | 361.3 (361.3–361.3) | **294.9 (294.9–294.9)** |
| Requests | 34 (34–34) | 25 (25–25) | **21 (21–21)** |
| Requests to other origins | **2 (2–2)** | **2 (2–2)** | **2 (2–2)** |

#### First visit: `quick-start`, Lighthouse on mobile

| Metric | vaporpress | vitepress (c2eb27d3) | astro (fe26e301) |
| --- | --- | --- | --- |
| Performance score | **100 (100–100)** | **100 (100–100)** | **100 (100–100)** |
| First Contentful Paint, simulated (ms) | **795 (793–805)** | **795 (794–805)** | 797 (795–834) |
| Largest Contentful Paint, simulated (ms) | **795 (793–805)** | **795 (794–805)** | 797 (795–834) |
| First Contentful Paint, observed (ms) | 103 (87–111) | **100 (88–110)** | 107 (96–115) |
| Largest Contentful Paint, observed (ms) | 103 (87–111) | **100 (88–110)** | 107 (96–115) |
| Cumulative Layout Shift | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** |
| Total Blocking Time, simulated (ms) | 3 (0–9) | **0 (0–1)** | 49 (27–63) |
| Speed Index, simulated (ms) | 1006 (956–1135) | 988 (862–1056) | **797 (795–834)** |
| JavaScript transferred (Brotli) (kB) | 59.7 (59.7–59.7) | 51.3 (51.3–51.3) | **29.1 (29.1–29.1)** |
| JavaScript decoded (kB) | 166.7 (166.7–166.7) | 145.2 (145.2–145.2) | **108.4 (108.4–108.4)** |
| Total transferred (kB) | 303.0 (303.0–303.0) | 283.3 (283.3–283.3) | **254.1 (254.1–254.1)** |
| Requests | 31 (31–31) | 21 (21–21) | **19 (19–19)** |
| Requests to other origins | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** |

#### First visit: `catalog`, Lighthouse on mobile

| Metric | vaporpress | vitepress (c2eb27d3) | astro (fe26e301) |
| --- | --- | --- | --- |
| Performance score | **100 (100–100)** | **100 (100–100)** | **100 (100–100)** |
| First Contentful Paint, simulated (ms) | **795 (794–803)** | 798 (794–1078) | 797 (795–823) |
| Largest Contentful Paint, simulated (ms) | **795 (794–804)** | 798 (794–1529) | 797 (796–828) |
| First Contentful Paint, observed (ms) | 99 (82–107) | **86 (78–94)** | 95 (82–107) |
| Largest Contentful Paint, observed (ms) | 99 (82–107) | **86 (78–94)** | 95 (82–107) |
| Cumulative Layout Shift | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** |
| Total Blocking Time, simulated (ms) | **0 (0–2)** | **0 (0–0)** | 7 (3–11) |
| Speed Index, simulated (ms) | 977 (831–1047) | 1033 (916–1287) | **797 (795–823)** |
| JavaScript transferred (Brotli) (kB) | 59.4 (59.4–59.4) | 51.1 (51.1–51.1) | **29.1 (29.1–29.1)** |
| JavaScript decoded (kB) | 165.8 (165.8–165.8) | 144.4 (144.4–144.4) | **108.4 (108.4–108.4)** |
| Total transferred (kB) | 296.9 (296.9–296.9) | 277.3 (277.3–277.3) | **246.3 (246.3–246.3)** |
| Requests | 31 (31–31) | 21 (21–21) | **19 (19–19)** |
| Requests to other origins | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** |

#### In the browser: desktop window, 4× CPU slowdown, slow 4G

| Metric | vaporpress | vitepress (c2eb27d3) | astro (fe26e301) |
| --- | --- | --- | --- |
| Tab responds: navigation start to the first click that selects a tab (ms) | **262 (239–283)** | 1701 (1681–1714) | 666 (622–680) |
| Search button responds: navigation start to the search field on screen, with a click every 50 ms (ms) | **414 (396–454)** | 2340 (2312–2364) | 1697 (1676–1719) |
| Tab switch: press to paint (ms) | 50 (46–55) | **36 (34–38)** | 53 (50–59) |
| Search: press to search field on screen (ms) | **66 (61–69)** | 512 (503–522) | 73 (69–78) |
| Page change, cold: press to new page on screen (ms) | **144 (134–149)** | 334 (328–340) | 279 (268–301) |
| Page change, link prefetched (ms) | **109 (104–116)** | 117 (110–125) | 269 (258–284) |
| Back: call to previous page on screen (ms) | **85 (80–90)** | 123 (111–129) | 279 (262–289) |
| Page change loads | same document (60/60) | same document (60/60) | new document (60/60) |
| Back loads | same document (60/60) | same document (60/60) | new document (60/60) |

## Run

On GitHub: run the workflow **Benchmark** (`gh workflow run benchmark.yml`), or push a change to `benchmarks/`. A pull request that changes `benchmarks/` (except this README), `vaporpress/src/` or the workflow runs it too. Read the tables in the summary of the run, or download the artifact `summary`.

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

`moon run benchmarks:test` tests the transform of the fixture for each framework, the static server, and the statistics and the tables of the results. It builds the vaporpress app, and checks its features in Chromium: the theme before the first paint and the switch, the mobile menu, the copy button, the search with its excerpts and its keys, the search that opens before the app hydrates, the table of contents, the previous and next pages, the keys of the tabs, and every rule of axe-core, which `axe.getRules()` lists (`test/framework-app.test.ts`). It does not measure.

The framework app imports the framework as `framework`, an alias in [`apps/framework/package.json`](apps/framework/package.json). A new name of the framework changes that line, and the name of its Vite plugin in `apps/framework/vite.config.ts` when that name changes too.
