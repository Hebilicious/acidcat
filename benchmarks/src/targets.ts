import { fileURLToPath } from "node:url";

export interface Target {
  readonly name: string;
  readonly root: string;
  /** Path prefixes of the hashed assets, which the server lets the browser keep for a year. */
  readonly immutable: readonly string[];
  readonly pages: Readonly<Record<string, string>>;
  /** A tab group on `path`: the selector of tab `n` (from 1), and a selector that matches only when tab `n` is selected. */
  readonly tabs: { readonly path: string; readonly tab: (n: number) => string; readonly selected: (n: number) => string };
  /** The button that opens the search box, and its text field. A site with no search has none. */
  readonly search: { readonly path: string; readonly button: string; readonly input: string } | undefined;
  /** A page change: on `from`, a click on `link` shows the page whose `h1` has `title`. Back shows `backTitle` again. */
  readonly change: { readonly from: string; readonly link: string; readonly title: string; readonly backTitle: string };
}

export interface Suite {
  readonly name: "fixture" | "site";
  readonly title: string;
  readonly targets: readonly Target[];
}

const app = (path: string): string => fileURLToPath(new URL(`../apps/${path}`, import.meta.url));

const fixtureChange = (sidebar: string, slash: string) => ({
  from: `/guide/installation${slash}`,
  link: `${sidebar} a[href="/guide/configuration${slash}"]`,
  title: "Configuration",
  backTitle: "Installation",
});

const fixturePages = (slash: string) => ({ home: "/", installation: `/guide/installation${slash}`, routing: `/guide/routing${slash}` });

export const fixtureSuite: Suite = {
  name: "fixture",
  title: "The same fixture in each framework",
  targets: [
    {
      name: "framework",
      root: app("framework/dist"),
      immutable: ["/assets/"],
      pages: fixturePages("/"),
      tabs: { path: "/guide/installation/", tab: (n) => `.tabs [role="tab"]:nth-child(${n})`, selected: (n) => `.tabs [role="tab"]:nth-child(${n})[aria-selected="true"]` },
      search: undefined,
      change: fixtureChange("nav.sidebar", "/"),
    },
    {
      name: "vitepress",
      root: app("vitepress/.vitepress/dist"),
      immutable: ["/assets/"],
      pages: fixturePages(""),
      tabs: { path: "/guide/installation", tab: (n) => `.vp-code-group .tabs label:nth-of-type(${n})`, selected: (n) => `.vp-code-group .blocks > :nth-child(${n}).active` },
      search: { path: "/guide/installation", button: ".VPNavBarSearchButton", input: ".VPLocalSearchBox input" },
      change: fixtureChange(".VPSidebar", ""),
    },
    {
      name: "starlight",
      root: app("starlight/dist"),
      immutable: ["/_astro/", "/pagefind/"],
      pages: fixturePages("/"),
      tabs: {
        path: "/guide/installation/",
        tab: (n) => `starlight-tabs li:nth-child(${n}) [role="tab"]`,
        selected: (n) => `starlight-tabs li:nth-child(${n}) [role="tab"][aria-selected="true"]`,
      },
      search: { path: "/guide/installation/", button: "button[data-open-modal]", input: "dialog[open] input" },
      change: fixtureChange("nav.sidebar", "/"),
    },
    {
      name: "docus",
      root: app("nuxt/.output/public"),
      immutable: ["/_nuxt/"],
      pages: fixturePages(""),
      tabs: { path: "/guide/installation", tab: (n) => `[role="tab"][id$="-trigger-${n - 1}"]`, selected: (n) => `[role="tab"][id$="-trigger-${n - 1}"][aria-selected="true"]` },
      search: { path: "/guide/installation", button: 'header [data-slot="center"] button', input: '[role="dialog"] input' },
      change: fixtureChange('aside[data-slot="left"]', ""),
    },
  ],
};

const siteTabs = (path: string, group: string) => ({
  path,
  tab: (n: number) => `${group} li:nth-child(${n}) a`,
  selected: (n: number) => `${group} li:nth-child(${n}) a[aria-selected="true"]`,
});

const siteChange = (slash: string) => ({
  from: `/docs/quick-start${slash}`,
  link: `nav[aria-label="Main"] a[href="/docs/concepts/catalog${slash}"]`,
  title: "Catalog",
  backTitle: "Quick start",
});

const sitePages = (slash: string) => ({ "quick-start": `/docs/quick-start${slash}`, catalog: `/docs/concepts/catalog${slash}` });

export const siteSuite = (roots: { readonly framework: string; readonly vitepress: string; readonly astro: string }): Suite => ({
  name: "site",
  title: "The docs pages of the AcidCat site",
  targets: [
    {
      name: "framework (#227)",
      root: roots.framework,
      immutable: ["/assets/"],
      pages: sitePages("/"),
      tabs: siteTabs("/docs/quick-start/", ".tabs"),
      search: undefined,
      change: siteChange("/"),
    },
    {
      name: "vitepress (main)",
      root: roots.vitepress,
      immutable: ["/assets/"],
      pages: sitePages(""),
      tabs: siteTabs("/docs/quick-start", ".tabs"),
      search: { path: "/docs/quick-start", button: "button.search-button", input: ".VPLocalSearchBox input" },
      change: siteChange(""),
    },
    {
      name: "astro (fe26e301)",
      root: roots.astro,
      immutable: ["/_astro/", "/pagefind/"],
      pages: sitePages("/"),
      tabs: siteTabs("/docs/quick-start/", "starlight-tabs"),
      search: { path: "/docs/quick-start/", button: "button[data-open-modal]", input: "dialog[open] input" },
      change: siteChange("/"),
    },
  ],
});
