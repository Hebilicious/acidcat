<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { onNear } from "../lib/gpu/support.ts";
import { mountSurfaceTabs } from "../lib/surface-tabs.ts";
import { surfaceSlot } from "../lib/home-slots.ts";
import { vCodeHtml } from "./code-html.ts";
import { data } from "./home.data.ts";

const renders = import.meta.glob<string>("../assets/surfaces/*.webp", { query: "?url", import: "default", eager: true });
const render = (id: string) => {
  const url = renders[`../assets/surfaces/${id}.webp`];
  if (url === undefined) throw new Error(`No render for the surface ${id}.`);
  return url;
};

const root = ref<HTMLElement>();
const lifetime = new AbortController();
onMounted(() => {
  const element = root.value;
  if (element !== undefined) onNear(element, lifetime.signal, () => mountSurfaceTabs(element, lifetime.signal));
});
onUnmounted(() => lifetime.abort());
</script>

<template>
  <section ref="root" class="surfaces" aria-labelledby="surfaces-title">
    <header class="section-head">
      <p class="eyebrow">Fig. 3 — Surfaces</p>
      <h2 id="surfaces-title">The five surfaces</h2>
      <p class="lede">Each surface exposes <code>aircon.power.set</code> with the same input and the same failures.</p>
    </header>
    <div class="surface-tabs" role="tablist" aria-labelledby="surfaces-title" hidden>
      <button
        v-for="(surface, index) in data.surfaces"
        :id="`tab-${surface.id}`"
        :key="surface.id"
        type="button"
        role="tab"
        :aria-controls="`surface-${surface.id}`"
        :aria-selected="String(index === 0)"
        :data-surface="surface.id"
      >
        <span class="gauge" aria-hidden="true"><span class="fluid"><i></i><i></i></span></span>
        {{ surface.name }}
      </button>
    </div>
    <div class="panels">
      <section v-for="surface in data.surfaces" :id="`surface-${surface.id}`" :key="surface.id" class="surface-panel" :aria-labelledby="`name-${surface.id}`">
        <div class="specimen"><img :src="render(surface.id)" alt="" width="384" height="384" loading="lazy" /></div>
        <div class="surface-copy">
          <header class="surface-heading">
            <p class="audience">{{ surface.who }}</p>
            <h3 :id="`name-${surface.id}`">{{ surface.name }}</h3>
          </header>
          <p class="description">{{ surface.text }}</p>
          <div v-code-html="surfaceSlot(surface.id)" class="sample"></div>
          <a :href="`/${surface.spec.replace(/\.md$/, '')}/`">Read the specification <span aria-hidden="true">→</span></a>
        </div>
      </section>
    </div>
  </section>
</template>

<style scoped>
  .surfaces {
    width: min(var(--layout-width-content), 100%);
    margin-inline: auto;
    padding: var(--spacing_fluid-space-3xl-4xl) var(--layout-gutter-inline) 0;
  }
  .section-head { margin-bottom: var(--spacing_fluid-space-xl); }
  .surface-tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 1px;
    padding: 1px;
    background: var(--palette-brass-800);
  }
  button {
    flex: 1 1 auto;
    display: flex;
    align-items: center;
    justify-content: center;
    gap: var(--spacing_fluid-space-xs);
    padding: var(--spacing_fluid-space-xs) var(--spacing_fluid-space-s);
    border: 0;
    background: var(--palette-ink-900);
    color: var(--palette-cream-400);
    font: inherit;
    font-family: var(--font-family-label);
    font-size: var(--typography_fluid-text-s);
    cursor: pointer;
  }
  button[aria-selected="true"] {
    color: var(--palette-cream-100);
    background: linear-gradient(var(--palette-ink-800), var(--palette-brass-950));
    box-shadow: inset 0 -2px var(--palette-brass-400);
  }
  button:focus-visible { outline: 2px solid var(--palette-cyan-400); outline-offset: -3px; }
  .gauge {
    position: relative;
    flex: none;
    width: 12px;
    height: 2.4rem;
    overflow: hidden;
    border: 1px solid var(--palette-brass-600);
    border-block: 3px solid var(--palette-brass-400);
    border-radius: var(--radius-size-s);
    background: linear-gradient(90deg, var(--palette-ink-950), var(--palette-ink-600), var(--palette-ink-925));
  }
  .fluid {
    position: absolute;
    inset: auto 1px 1px;
    height: 16%;
    overflow: hidden;
    border-radius: inherit;
    background: linear-gradient(var(--palette-acid-400), var(--palette-acid-700));
    transition: height 700ms ease;
  }
  button[aria-selected="true"] .fluid { height: 80%; }
  button:hover .fluid { height: 50%; }
  button[aria-selected="true"]:hover .fluid { height: 96%; }
  .fluid i {
    position: absolute;
    bottom: 0;
    left: 1px;
    width: 3px;
    height: 3px;
    border-radius: 50%;
    background: var(--palette-acid-200);
    opacity: 0;
  }
  button:is(:hover, [aria-selected="true"]) i { animation: bubble 1.5s ease-in infinite; }
  button:is(:hover, [aria-selected="true"]) i + i { left: 3px; animation-delay: -0.7s; }
  @keyframes bubble {
    20% { opacity: 1; }
    to { transform: translateY(-1.6rem); opacity: 0; }
  }
  .panels { display: grid; }
  .surface-panel[role="tabpanel"] { grid-area: 1 / 1; }
  .surface-panel[inert] { visibility: hidden; }
  .surface-panel {
    display: grid;
    grid-template-columns: 10rem minmax(0, 1fr);
    align-items: start;
    gap: var(--spacing_fluid-space-m);
    padding: var(--spacing_fluid-space-l-xl);
    border: 1px solid var(--palette-brass-800);
    background: var(--palette-ink-925);
  }
  .surface-tabs[hidden] { display: none; }
  .specimen {
    position: relative;
    width: 100%;
    aspect-ratio: 1;
  }
  .specimen::after {
    content: "";
    position: absolute;
    inset: auto 15% 0;
    height: 12%;
    background: radial-gradient(closest-side, color-mix(in oklch, var(--palette-acid-400) 24%, transparent), transparent);
    filter: blur(4px);
  }
  .specimen img {
    position: relative;
    z-index: 1;
    width: 100%;
    height: 100%;
    object-fit: contain;
  }
  .surface-panel[role="tabpanel"]:not([inert]) .specimen img {
    translate: 0 -3%;
    filter: brightness(1.08);
    animation: specimen-float 6s ease-in-out infinite;
  }
  @keyframes specimen-float { 50% { transform: translateY(-3%); } }
  .surface-copy {
    min-width: 0;
  }
  .audience, .surface-copy a {
    font-family: var(--font-family-label);
    font-size: var(--typography_fluid-text-xs);
    letter-spacing: var(--font-tracking-label);
    text-transform: uppercase;
  }
  .audience { margin: 0 0 var(--spacing_fluid-space-xs); color: var(--palette-cyan-400); }
  h3 { margin: 0; font-family: var(--font-family-display); font-size: var(--typography_fluid-display-xl); line-height: 1.12; }
  .description { margin: var(--spacing_fluid-space-m) 0; color: var(--palette-cream-400); }
  .sample {
    padding: var(--spacing_fluid-space-s-m);
    border-inline-start: 2px solid var(--palette-brass-600);
    background: var(--palette-ink-950);
    overflow-x: auto;
    font-size: var(--typography_fluid-text-s);
    line-height: 1.55;
  }
  .surface-copy a { display: inline-block; margin-top: var(--spacing_fluid-space-m); color: var(--palette-brass-300); text-underline-offset: 0.3em; }
  @media (max-width: 720px) {
    button { justify-content: start; }
    .surface-panel {
      grid-template-columns: minmax(0, 1fr) min(9rem, 40%);
      grid-template-rows: auto auto auto 1fr;
      gap: 0 var(--spacing_fluid-space-s);
      padding: var(--spacing_fluid-space-m);
    }
    .specimen { grid-area: 1 / 2; width: 100%; margin: 0; }
    .surface-copy { display: contents; }
    .surface-heading { grid-area: 1 / 1; align-self: start; }
    .surface-copy > :not(.surface-heading) { grid-column: 1 / -1; align-self: start; }
    .surface-copy a { justify-self: start; }
    h3 { font-size: var(--typography_fluid-display-l); overflow-wrap: anywhere; }
  }
  @media (prefers-reduced-motion: reduce) {
    .fluid { transition: none; }
    .surface-panel[role="tabpanel"]:not([inert]) .specimen img { animation: none; translate: none; }
    button:is(:hover, [aria-selected="true"]) i { animation: none; }
  }
</style>
