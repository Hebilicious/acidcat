<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { createBluescreen, supportsHtmlInCanvas } from "../lib/bluescreen.ts";
import { onNear } from "../lib/gpu/support.ts";
import { revealSections } from "../lib/home-page.ts";
import Exploded from "./Exploded.vue";

const specs = [
  ["Specification", "0.1 draft"],
  ["Schemas", "JSON Schema 2020-12"],
  ["MCP revision", "2026-07-28"],
  ["Surfaces", "TypeScript · WebMCP · MCP · CLI · HTTP"],
  ["Catalog in", "TypeScript · Python · Go · Rust · Pkl"],
  ["Cores", "Effect · TypeScript · Rust"],
];

const root = ref<HTMLElement>();
const sheet = ref<HTMLElement>();
const lifetime = new AbortController();
onMounted(() => {
  if (root.value !== undefined) revealSections(root.value, lifetime.signal);
  const panel = sheet.value;
  if (panel === undefined || !supportsHtmlInCanvas()) return;
  const motion = matchMedia("(prefers-reduced-motion: reduce)");
  let screen = new AbortController();
  const draw = () => {
    screen.abort();
    screen = new AbortController();
    void createBluescreen(panel, { still: motion.matches }, AbortSignal.any([lifetime.signal, screen.signal]));
  };
  onNear(panel, lifetime.signal, () => {
    draw();
    motion.addEventListener("change", draw, { signal: lifetime.signal });
  });
});
onUnmounted(() => lifetime.abort());
</script>

<template>
  <div ref="root" class="blueprint-row">
    <div class="blueprint">
      <p class="blueprint-label">Exploded drawing</p>
      <Exploded />
    </div>
    <div class="spec-frame">
      <section ref="sheet" class="spec-sheet" aria-labelledby="spec-title">
        <h3 id="spec-title">Key specifications</h3>
        <dl>
          <div v-for="[term, value] in specs" :key="term">
            <dt>{{ term }}</dt>
            <dd>{{ value }}</dd>
          </div>
        </dl>
      </section>
    </div>
  </div>
</template>

<style scoped>
  .blueprint-row {
    display: grid;
    grid-template-columns: minmax(0, 1.2fr) minmax(0, 1fr);
    align-items: center;
    gap: var(--spacing_fluid-space-l-xl);
    margin-top: var(--spacing_fluid-space-xl);
  }
  .blueprint {
    position: relative;
    padding: var(--spacing_fluid-space-m);
    border: 1px solid color-mix(in oklch, var(--palette-cyan-400) 25%, transparent);
    background: color-mix(in oklch, var(--palette-ink-950) 45%, transparent);
  }
  .blueprint::before,
  .blueprint::after {
    content: "";
    position: absolute;
    width: 22px;
    height: 22px;
    border: 2px solid var(--palette-cyan-400);
  }
  .blueprint::before {
    top: -2px;
    left: -2px;
    border-right: 0;
    border-bottom: 0;
  }
  .blueprint::after {
    right: -2px;
    bottom: -2px;
    border-left: 0;
    border-top: 0;
  }
  .blueprint-label {
    margin: 0 0 var(--spacing_fluid-space-2xs);
    font-family: var(--font-family-mono);
    font-size: var(--typography_fluid-text-xs);
    letter-spacing: var(--font-tracking-label);
    text-transform: uppercase;
    color: var(--palette-cyan-400);
  }
  .spec-frame {
    border: 1px solid color-mix(in oklch, var(--palette-cyan-400) 48%, transparent);
    border-inline-start: 3px solid var(--palette-cyan-400);
    background: radial-gradient(ellipse at top left, var(--palette-blueprint-800), var(--palette-ink-925));
    box-shadow: inset 0 0 var(--spacing_fluid-space-l) var(--palette-ink-950);
  }
  .spec-frame :deep(canvas) { display: block; width: 100%; }
  .spec-sheet {
    box-sizing: border-box;
    width: 100%;
    padding: var(--spacing_fluid-space-m) var(--spacing_fluid-space-m) var(--spacing_fluid-space-l);
  }
  h3 {
    display: flex;
    align-items: center;
    gap: var(--spacing_fluid-space-xs);
    margin: 0 0 var(--spacing_fluid-space-s);
    font-family: var(--font-family-label);
    font-size: var(--typography_fluid-text-s);
    letter-spacing: var(--font-tracking-label);
    text-transform: uppercase;
    color: var(--palette-cyan-400);
  }
  h3::after {
    content: "";
    flex: 1;
    height: var(--spacing_fluid-space-3xs);
    background: repeating-linear-gradient(115deg, transparent 0 3px, currentColor 3px 4px);
    opacity: .45;
  }
  dl {
    margin: 0;
    display: grid;
    gap: var(--spacing_fluid-space-3xs);
    font-family: var(--font-family-mono);
    font-size: var(--typography_fluid-text-xs);
  }
  dl div {
    display: grid;
    grid-template-columns: minmax(0, .65fr) minmax(0, 1fr);
    gap: var(--spacing_fluid-space-s);
    border-bottom: 1px dashed color-mix(in oklch, var(--palette-cyan-400) 18%, transparent);
    padding-block: var(--spacing_fluid-space-2xs);
  }
  dt {
    color: color-mix(in oklch, var(--palette-cyan-400) 55%, var(--palette-cream-100));
  }
  dd {
    margin: 0;
    color: var(--palette-cream-100);
  }

  @media (max-width: 900px) {
    .blueprint-row {
      grid-template-columns: minmax(0, 1fr);
    }
    dl div {
      grid-template-columns: 1fr;
      gap: var(--spacing_fluid-space-3xs);
    }
  }
</style>
