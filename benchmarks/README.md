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

The tables below pool two runs of the workflow on commit `26dd7a2f`, 3 jobs each for each suite: [45608982279](https://github.com/Hebilicious/acidcat/actions/runs/45608982279) and [45608969254](https://github.com/Hebilicious/acidcat/actions/runs/45608969254). Their artifacts keep the raw results. The commit that adds this section changes only this README.

Where vaporpress is not the best:

- **Script weight, in every first visit.** On the fixture, vaporpress transfers 43.7–44.3 kB of script (123–124 kB decoded), and Starlight 26.9–28.2 kB (106–108 kB). On the AcidCat site, vaporpress transfers 57.0–62.0 kB (159–166 kB decoded), VitePress 49.4–58.8 kB, and Astro 16.7–29.1 kB.
- **Total transfer and requests on the AcidCat site.** On all three routes, vaporpress transfers the most and makes the most requests: the homepage 370.9 kB and 34 requests (VitePress 359.6 kB and 25, Astro 294.9 kB and 21), the quick start 302.3 kB and 31 (281.6 and 21, 254.1 and 19), the catalog 296.3 kB and 31 (275.7 and 21, 246.3 and 19). On the fixture homepage, vaporpress transfers 54.2 kB and Starlight 51.6 kB.
- **The simulated first paint of the homepage of the AcidCat site**: FCP and Speed Index 1,721 ms, against 786 and 796 ms for Astro and 1,163 ms for VitePress; LCP 3,159 ms against 2,711 ms for Astro and 3,009 ms for VitePress. The observed values of the same runs are the best of the three: first paint 107 ms, against 144 ms for Astro and 155 ms for VitePress. The quick start and the catalog have a simulated Speed Index of 970 and 1,000 ms, against 796 and 797 ms for Astro.
- **The observed first paint and largest paint of the catalog page**: both 87 ms, against 71 ms for VitePress. On the fixture, Starlight paints first on each page (39–47 ms, against 48–54 ms for vaporpress), with overlapping spreads.
- **Search.** From the press to the search field on screen, vaporpress takes 204 ms on the fixture and 86 ms on the AcidCat site, Starlight 50 ms and Astro 68 ms, whose dialog is in the HTML. From the start of the navigation, the search button of the AcidCat site responds after 2,406 ms on vaporpress, 2,326 ms on VitePress and 1,679 ms on Astro.
- **Tab switch on the AcidCat site**: 51 ms, against 35 ms for VitePress.
- **By a few milliseconds of simulation**: the simulated FCP and Speed Index of the fixture homepage (753 ms, Starlight 752 ms), and the simulated FCP and LCP of the quick start (both 798 ms; the FCP of VitePress and Astro is 796 ms, the LCP 796 ms for VitePress and 797 ms for Astro) and of the catalog (799 and 804 ms, VitePress 796 ms).

vaporpress is the best, or tied, on the other rows: the scores, CLS, TBT, the requests of the fixture, the observed largest paint (except on the catalog page), when a tab and the search button respond on the fixture, when a tab responds on the AcidCat site, and the page changes and Back in both suites.

### The same fixture in each framework

6 jobs × 5 runs = 30 samples for each cell: the median, and the first to the third quartile. Lighthouse 13.6.0, Chromium 158.0.8127.18. The best median of each row is in bold.

A simulated value is what Lighthouse computes for a slow phone (slow 4G, 4× CPU) from the trace of the load. An observed value is in the trace itself: the runner loads the page with no throttling.

#### First visit: `home`, Lighthouse on mobile

| Metric | vaporpress | vitepress | starlight | docus |
| --- | --- | --- | --- | --- |
| Performance score | **100 (100–100)** | 97 (97–97) | **100 (100–100)** | 72 (70–73) |
| First Contentful Paint, simulated (ms) | 753 (752–754) | 866 (628–1102) | **752 (751–752)** | 1037 (1008–1083) |
| Largest Contentful Paint, simulated (ms) | **1353 (1352–1354)** | 2556 (2554–2558) | **1353 (1352–1354)** | 5957 (5556–6391) |
| First Contentful Paint, observed (ms) | 48 (39–61) | 89 (71–102) | **39 (30–51)** | 144 (118–154) |
| Largest Contentful Paint, observed (ms) | **57 (49–69)** | 89 (71–102) | 61 (55–75) | 177 (162–199) |
| Cumulative Layout Shift | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | 0.077 (0.077–0.077) |
| Total Blocking Time, simulated (ms) | **0 (0–0)** | 26 (13–40) | **0 (0–0)** | 285 (202–336) |
| Speed Index, simulated (ms) | 753 (752–754) | 1001 (674–1102) | **752 (751–752)** | 1037 (1008–1083) |
| JavaScript transferred (Brotli) (kB) | 44.3 (44.3–44.3) | 62.2 (62.2–62.2) | **26.9 (26.9–26.9)** | 360.2 (360.2–360.2) |
| JavaScript decoded (kB) | 123.3 (123.3–123.3) | 190.3 (190.3–190.3) | **105.6 (105.6–105.6)** | 1246.4 (1246.4–1246.4) |
| Total transferred (kB) | 54.2 (54.2–54.2) | 284.3 (284.3–284.3) | **51.6 (51.6–51.6)** | 1116.0 (1115.9–1116.0) |
| Requests | **9 (9–9)** | 11 (11–11) | 10 (10–10) | 216 (216–216) |
| Requests to other origins | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** |

#### First visit: `installation`, Lighthouse on mobile

| Metric | vaporpress | vitepress | starlight | docus |
| --- | --- | --- | --- | --- |
| Performance score | **100 (100–100)** | **100 (100–100)** | **100 (100–100)** | 94 (92–97) |
| First Contentful Paint, simulated (ms) | **752 (751–752)** | 1099 (635–1113) | 903 (902–904) | 1049 (1009–1092) |
| Largest Contentful Paint, simulated (ms) | **752 (751–752)** | 1099 (635–1113) | 1354 (1353–1355) | 1059 (1017–1097) |
| First Contentful Paint, observed (ms) | 48 (39–57) | 82 (65–92) | **42 (35–48)** | 180 (161–207) |
| Largest Contentful Paint, observed (ms) | **48 (39–57)** | 82 (65–92) | 67 (56–73) | 180 (161–207) |
| Cumulative Layout Shift | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** |
| Total Blocking Time, simulated (ms) | **0 (0–1)** | 24 (11–45) | **0 (0–0)** | 277 (184–337) |
| Speed Index, simulated (ms) | **752 (751–752)** | 1099 (642–1113) | 903 (902–904) | 1216 (1167–1303) |
| JavaScript transferred (Brotli) (kB) | 43.7 (43.7–43.7) | 61.5 (61.5–61.5) | **28.2 (28.2–28.2)** | 323.8 (323.8–323.9) |
| JavaScript decoded (kB) | 123.1 (123.1–123.1) | 189.5 (189.5–189.5) | **108.1 (108.1–108.1)** | 1148.8 (1148.8–1148.8) |
| Total transferred (kB) | **49.2 (49.2–49.2)** | 155.1 (155.1–155.1) | 50.2 (50.2–50.2) | 954.3 (954.3–954.4) |
| Requests | **8 (8–8)** | 9 (9–9) | 11 (11–11) | 224 (224–224) |
| Requests to other origins | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** |

#### First visit: `routing`, Lighthouse on mobile

| Metric | vaporpress | vitepress | starlight | docus |
| --- | --- | --- | --- | --- |
| Performance score | **100 (100–100)** | **100 (100–100)** | **100 (100–100)** | 94 (92–98) |
| First Contentful Paint, simulated (ms) | **752 (751–753)** | 883 (649–1118) | 903 (902–904) | 1058 (1028–1110) |
| Largest Contentful Paint, simulated (ms) | **752 (751–753)** | 883 (649–1118) | 1353 (970–1354) | 1058 (1028–1118) |
| First Contentful Paint, observed (ms) | 54 (44–60) | 85 (64–95) | **47 (34–59)** | 190 (164–202) |
| Largest Contentful Paint, observed (ms) | **54 (44–60)** | 85 (64–95) | 67 (57–76) | 190 (164–202) |
| Cumulative Layout Shift | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** |
| Total Blocking Time, simulated (ms) | **0 (0–2)** | 30 (17–50) | **0 (0–0)** | 295 (179–353) |
| Speed Index, simulated (ms) | **752 (751–753)** | 966 (653–1118) | 903 (902–904) | 1199 (1144–1235) |
| JavaScript transferred (Brotli) (kB) | 44.0 (44.0–44.0) | 61.6 (61.6–61.6) | **28.2 (28.2–28.2)** | 323.9 (323.8–324.0) |
| JavaScript decoded (kB) | 124.2 (124.2–124.2) | 189.5 (189.5–189.5) | **108.1 (108.1–108.1)** | 1143.6 (1143.5–1143.6) |
| Total transferred (kB) | **50.2 (50.2–50.2)** | 155.9 (155.9–155.9) | **50.2 (50.2–50.2)** | 956.7 (956.7–956.8) |
| Requests | **8 (8–8)** | 9 (9–9) | 11 (11–11) | 228 (228–228) |
| Requests to other origins | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** |

#### In the browser: desktop window, 4× CPU slowdown, slow 4G

| Metric | vaporpress | vitepress | starlight | docus |
| --- | --- | --- | --- | --- |
| Tab responds: navigation start to the first click that selects a tab (ms) | **634 (619–643)** | 1154 (1123–1181) | 669 (642–677) | 3237 (3170–3297) |
| Search button responds: navigation start to the search field on screen, with a click every 50 ms (ms) | **857 (842–869)** | 1510 (1470–1541) | 927 (888–946) | 4253 (4102–4405) |
| Tab switch: press to paint (ms) | **26 (26–27)** | 27 (27–28) | 27 (26–27) | 37 (34–41) |
| Search: press to search field on screen (ms) | 204 (202–207) | 312 (308–317) | **50 (45–55)** | 254 (219–290) |
| Page change, cold: press to new page on screen (ms) | **162 (153–166)** | 168 (134–178) | 284 (274–300) | 401 (362–432) |
| Page change, link prefetched (ms) | **31 (30–32)** | 55 (52–57) | 283 (265–297) | 561 (544–573) |
| Back: call to previous page on screen (ms) | **25 (23–32)** | 39 (37–41) | 120 (100–129) | 181 (154–197) |
| Page change loads | same document (30/30) | same document (30/30) | new document (30/30) | same document (30/30) |
| Back loads | same document (30/30) | same document (30/30) | new document (30/30) | same document (30/30) |

### The AcidCat site

6 jobs × 5 runs = 30 samples for each cell: the median, and the first to the third quartile. Lighthouse 13.6.0, Chromium 158.0.8127.18. The best median of each row is in bold.

A simulated value is what Lighthouse computes for a slow phone (slow 4G, 4× CPU) from the trace of the load. An observed value is in the trace itself: the runner loads the page with no throttling.

#### First visit: `home`, Lighthouse on mobile

| Metric | vaporpress | vitepress (main) | astro (fe26e301) |
| --- | --- | --- | --- |
| Performance score | **93 (92–93)** | 92 (90–94) | **93 (92–95)** |
| First Contentful Paint, simulated (ms) | 1721 (1702–1729) | 1163 (795–1429) | **786 (755–796)** |
| Largest Contentful Paint, simulated (ms) | 3159 (3157–3163) | 3009 (3007–3011) | **2711 (2709–2714)** |
| First Contentful Paint, observed (ms) | **107 (93–129)** | 155 (136–178) | 144 (125–155) |
| Largest Contentful Paint, observed (ms) | **107 (93–129)** | 155 (136–178) | 144 (125–155) |
| Cumulative Layout Shift | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** |
| Total Blocking Time, simulated (ms) | **21 (10–27)** | 80 (10–251) | 198 (139–244) |
| Speed Index, simulated (ms) | 1721 (1702–1729) | 1163 (795–1429) | **796 (755–897)** |
| JavaScript transferred (Brotli) (kB) | 62.0 (62.0–62.0) | 58.8 (58.8–58.8) | **16.7 (16.7–16.7)** |
| JavaScript decoded (kB) | 165.8 (165.8–165.8) | 161.8 (161.8–161.8) | **34.7 (34.7–34.7)** |
| Total transferred (kB) | 370.9 (370.9–370.9) | 359.6 (359.6–359.6) | **294.9 (294.9–294.9)** |
| Requests | 34 (34–34) | 25 (25–25) | **21 (21–21)** |
| Requests to other origins | **2 (2–2)** | **2 (2–2)** | **2 (2–2)** |

#### First visit: `quick-start`, Lighthouse on mobile

| Metric | vaporpress | vitepress (main) | astro (fe26e301) |
| --- | --- | --- | --- |
| Performance score | **100 (100–100)** | **100 (100–100)** | **100 (99–100)** |
| First Contentful Paint, simulated (ms) | 798 (794–806) | **796 (794–918)** | **796 (795–894)** |
| Largest Contentful Paint, simulated (ms) | 798 (794–806) | **796 (794–918)** | 797 (795–914) |
| First Contentful Paint, observed (ms) | **94 (81–107)** | 134 (115–153) | 96 (75–106) |
| Largest Contentful Paint, observed (ms) | **94 (81–107)** | 134 (115–153) | 96 (75–106) |
| Cumulative Layout Shift | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** |
| Total Blocking Time, simulated (ms) | **0 (0–0)** | 19 (0–40) | 52 (25–68) |
| Speed Index, simulated (ms) | 970 (835–1100) | 936 (848–1161) | **796 (795–894)** |
| JavaScript transferred (Brotli) (kB) | 57.3 (57.3–57.3) | 49.6 (49.6–49.6) | **29.1 (29.1–29.1)** |
| JavaScript decoded (kB) | 160.0 (160.0–160.0) | 139.6 (139.6–139.6) | **108.4 (108.4–108.4)** |
| Total transferred (kB) | 302.3 (302.3–302.3) | 281.6 (281.6–281.6) | **254.1 (254.1–254.1)** |
| Requests | 31 (31–31) | 21 (21–21) | **19 (19–19)** |
| Requests to other origins | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** |

#### First visit: `catalog`, Lighthouse on mobile

| Metric | vaporpress | vitepress (main) | astro (fe26e301) |
| --- | --- | --- | --- |
| Performance score | **100 (100–100)** | **100 (100–100)** | **100 (100–100)** |
| First Contentful Paint, simulated (ms) | 799 (794–1383) | **796 (768–956)** | 797 (796–822) |
| Largest Contentful Paint, simulated (ms) | 804 (794–1386) | **796 (768–956)** | 808 (796–833) |
| First Contentful Paint, observed (ms) | 87 (75–100) | **71 (64–88)** | 86 (66–106) |
| Largest Contentful Paint, observed (ms) | 87 (75–100) | **71 (64–88)** | 86 (66–106) |
| Cumulative Layout Shift | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** | **0.000 (0.000–0.000)** |
| Total Blocking Time, simulated (ms) | **0 (0–2)** | **0 (0–0)** | 3 (0–15) |
| Speed Index, simulated (ms) | 1000 (805–1383) | 1029 (938–1218) | **797 (796–822)** |
| JavaScript transferred (Brotli) (kB) | 57.0 (57.0–57.0) | 49.4 (49.4–49.4) | **29.1 (29.1–29.1)** |
| JavaScript decoded (kB) | 159.1 (159.1–159.1) | 138.8 (138.8–138.8) | **108.4 (108.4–108.4)** |
| Total transferred (kB) | 296.3 (296.3–296.3) | 275.7 (275.7–275.7) | **246.3 (246.3–246.3)** |
| Requests | 31 (31–31) | 21 (21–21) | **19 (19–19)** |
| Requests to other origins | **0 (0–0)** | **0 (0–0)** | **0 (0–0)** |

#### In the browser: desktop window, 4× CPU slowdown, slow 4G

| Metric | vaporpress | vitepress (main) | astro (fe26e301) |
| --- | --- | --- | --- |
| Tab responds: navigation start to the first click that selects a tab (ms) | **235 (226–241)** | 1661 (1649–1702) | 662 (609–689) |
| Search button responds: navigation start to the search field on screen, with a click every 50 ms (ms) | 2406 (2386–2423) | 2326 (2284–2350) | **1679 (1648–1712)** |
| Tab switch: press to paint (ms) | 51 (41–55) | **35 (32–41)** | 54 (43–62) |
| Search: press to search field on screen (ms) | 86 (71–102) | 508 (498–529) | **68 (56–78)** |
| Page change, cold: press to new page on screen (ms) | **121 (98–145)** | 338 (330–343) | 255 (225–284) |
| Page change, link prefetched (ms) | **102 (82–114)** | 112 (91–124) | 254 (223–282) |
| Back: call to previous page on screen (ms) | **80 (60–86)** | 108 (91–125) | 238 (204–277) |
| Page change loads | same document (30/30) | same document (30/30) | new document (30/30) |
| Back loads | same document (30/30) | same document (30/30) | new document (30/30) |

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
