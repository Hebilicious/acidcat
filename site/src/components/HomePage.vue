<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { isExternal } from "../lib/external-links.ts";
import { revealSections, showStarCount } from "../lib/home-page.ts";
import Mark from "../theme/Mark.vue";
import SiteNav from "../theme/SiteNav.vue";
import LivingPlate from "./LivingPlate.vue";
import { nearFigure } from "./near-figure.ts";

const Schematic = nearFigure(() => import("./Schematic.vue"));
const Blueprint = nearFigure(() => import("./Blueprint.vue"));
const Surfaces = nearFigure(() => import("./Surfaces.vue"));
const CoreScreens = nearFigure(() => import("./CoreScreens.vue"));

const repository = "https://github.com/Hebilicious/acidcat";
const footerColumns = [
  {
    heading: "Docs",
    links: [
      { label: "Introduction", href: "/docs/" },
      { label: "Quick start", href: "/docs/quick-start/" },
      { label: "Concepts", href: "/docs/concepts/catalog/" },
      { label: "Guides", href: "/docs/guides/write-a-catalog/" },
      { label: "Reference", href: "/docs/reference/cli/" },
    ],
  },
  {
    heading: "Spec",
    links: [
      { label: "Catalog", href: "/spec/catalog/" },
      { label: "Invocation", href: "/spec/invocation/" },
      { label: "Events", href: "/spec/events/" },
      { label: "Surfaces", href: "/spec/surfaces/" },
      { label: "Conformance", href: "/spec/conformance/" },
    ],
  },
  {
    heading: "Project",
    links: [
      { label: "Packages", href: "/packages/" },
      { label: "Source code", href: repository },
      { label: "Releases", href: `${repository}/releases` },
      { label: "Issues", href: `${repository}/issues` },
      { label: "License", href: `${repository}/blob/main/LICENSE` },
    ],
  },
];

const root = ref<HTMLElement>();
const starCount = ref<HTMLElement>();
const lifetime = new AbortController();
onMounted(() => {
  if (starCount.value !== undefined) showStarCount(starCount.value, lifetime.signal);
  if (root.value !== undefined) revealSections(root.value, lifetime.signal);
});
onUnmounted(() => lifetime.abort());
</script>

<template>
  <div ref="root" class="home-page">
    <a class="skip" href="#main">Skip to content</a>
    <header class="nav">
      <SiteNav />
    </header>

    <main id="main">
      <section class="hero" aria-labelledby="hero-title">
        <div class="hero-stage">
          <LivingPlate />
        </div>
        <div class="hero-copy">
          <p class="eyebrow reveal">An open specification · 0.1 draft</p>
          <h1 id="hero-title" class="reveal">AcidCat</h1>
          <p class="hero-expansion reveal"><b>A</b>pplication <b>C</b>apability <b>Id</b>entification <b>Cat</b>alog</p>
          <p class="hero-lede reveal">Describe what your application can do once. Serve it as a command line, an MCP server, an HTTP API and typed code.</p>
          <div class="actions reveal">
            <a class="button button-acid" href="/docs/"><span class="button-face"><span class="button-text">Get started</span><i class="shine" aria-hidden="true"></i></span></a>
            <a class="button button-brass button-star" :href="repository" target="_blank" rel="noopener noreferrer"
              ><span class="button-face"
                ><span class="button-text"
                  ><svg class="button-icon" viewBox="0 0 24 24" aria-hidden="true"><path d="m12 2.8 2.8 5.8 6.3.9-4.6 4.4 1.1 6.3L12 17.2l-5.6 3 1.1-6.3L2.9 9.5l6.3-.9z" /></svg>Star on GitHub</span
                ><i class="shine" aria-hidden="true"></i></span
              ><span ref="starCount" class="star-count" data-star-count hidden></span
            ></a>
          </div>
        </div>
      </section>

      <div class="blueprint-zone">
        <Schematic />

        <section class="flow" aria-labelledby="flow-title">
          <div class="flow-inner">
            <header class="section-head">
              <p class="eyebrow">Fig. 2 — How the parts fit</p>
              <h2 id="flow-title">Spec, catalog, <em>core, verify</em></h2>
              <p class="lede">The specification defines the catalog and the surfaces. A catalog lists the capabilities of one application. A core runs them, and <code>acid-cat conform</code> tests the result from outside.</p>
            </header>
            <Blueprint />
          </div>
        </section>
      </div>

      <Surfaces />

      <CoreScreens />
    </main>

    <footer class="footer">
      <div class="footer-rail" aria-hidden="true"><span></span><span></span><span></span><span></span><span></span></div>
      <div class="footer-inner">
        <div class="footer-brand">
          <Mark id-suffix="footer" :size="56" />
          <div class="footer-name">AcidCat</div>
          <p class="footer-expansion"><b>A</b>pplication <b>C</b>apability <b>Id</b>entification <b>Cat</b>alog</p>
          <p class="footer-status"><span class="footer-lamp" aria-hidden="true"></span>Specification 0.1 · Draft</p>
        </div>
        <nav class="footer-columns" aria-label="Footer">
          <div v-for="column in footerColumns" :key="column.heading">
            <p class="footer-heading">{{ column.heading }}</p>
            <ul>
              <li v-for="link in column.links" :key="link.href">
                <a :href="link.href" :target="isExternal(link.href) ? '_blank' : undefined" :rel="isExternal(link.href) ? 'noopener noreferrer' : undefined">{{ link.label }}</a>
              </li>
            </ul>
          </div>
        </nav>
      </div>
      <p class="footer-watermark" aria-hidden="true">AcidCat</p>
    </footer>
  </div>
</template>
