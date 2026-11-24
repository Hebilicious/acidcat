<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { mountCoreConsole } from "../lib/core-console.ts";
import { coreSlot } from "../lib/home-slots.ts";
import { vCodeHtml } from "./code-html.ts";
import { data } from "./home.data.ts";

const root = ref<HTMLElement>();
const lifetime = new AbortController();
onMounted(() => {
  if (root.value !== undefined) mountCoreConsole(root.value, lifetime.signal);
});
onUnmounted(() => lifetime.abort());
</script>

<template>
  <section ref="root" class="cores" aria-labelledby="cores-title">
    <div class="cores-inner">
      <header class="section-head">
        <p class="eyebrow">Fig. 4 — Cores</p>
        <h2 id="cores-title">Run it <em>with a core</em></h2>
        <p class="lede">A core runs the capabilities and serves the surfaces. Each core has the same features in its own style, and each one passes <code>acid-cat conform</code>.</p>
      </header>
      <div class="console">
        <div class="console-tabs" role="tablist" aria-label="Core" aria-orientation="vertical">
          <button
            v-for="(core, index) in data.cores"
            :id="`tab-${core.id}`"
            :key="core.id"
            type="button"
            role="tab"
            :aria-controls="`panel-${core.id}`"
            :aria-selected="index === 0 ? 'true' : 'false'"
            :tabindex="index === 0 ? 0 : -1"
            :data-core-tab="core.id"
          >
            <span class="tab-label">{{ core.label }}</span>
            <span class="tab-package">{{ core.packageName }}</span>
          </button>
        </div>
        <div class="console-frame">
          <div class="console-screen" data-console-screen>
            <div v-for="(core, index) in data.cores" :id="`panel-${core.id}`" :key="core.id" class="console-panel" role="tabpanel" :aria-labelledby="`tab-${core.id}`" :hidden="index !== 0">
              <p class="console-note">{{ core.note }}</p>
              <div v-code-html="coreSlot(core.id)" class="console-code"></div>
              <a class="console-source" :href="core.source" target="_blank" rel="noopener noreferrer">Open GitHub example <span aria-hidden="true">↗</span></a>
            </div>
          </div>
        </div>
      </div>
    </div>
  </section>
</template>

<style scoped>
  .cores {
    margin-top: var(--spacing_fluid-space-2xl-3xl);
    padding-block: var(--spacing_fluid-space-2xl-3xl) var(--spacing_fluid-space-3xl-4xl);
    background:
      radial-gradient(ellipse 55% 45% at 65% 55%, color-mix(in oklch, var(--palette-cyan-400) 7%, transparent), transparent 70%),
      linear-gradient(180deg, transparent, color-mix(in oklch, var(--palette-ink-800) 60%, transparent) 30%, color-mix(in oklch, var(--palette-ink-800) 60%, transparent) 70%, var(--palette-ink-950));
  }
  .cores-inner {
    width: min(var(--layout-width-content), 100%);
    margin-inline: auto;
    padding-inline: var(--layout-gutter-inline);
  }
  .console {
    display: grid;
    grid-template-columns: minmax(10rem, 14rem) minmax(0, 1fr);
    align-items: start;
    margin-top: var(--spacing_fluid-space-l);
  }
  .console-tabs {
    display: flex;
    flex-direction: column;
    gap: var(--spacing_fluid-space-3xs);
  }
  .console-tabs button {
    position: relative;
    display: grid;
    gap: var(--spacing_fluid-space-3xs);
    padding: var(--spacing_fluid-space-xs) var(--spacing_fluid-space-s);
    margin-right: -1px;
    border: 1px solid color-mix(in oklch, var(--palette-brass-400) 30%, transparent);
    border-right: 0;
    border-radius: var(--radius-size-m) 0 0 var(--radius-size-m);
    background: var(--palette-ink-900);
    color: var(--palette-cream-400);
    text-align: left;
    cursor: pointer;
    transition:
      color 0.2s,
      background-color 0.2s,
      box-shadow 0.3s;
  }
  .console-tabs button:hover {
    color: var(--palette-cream-100);
    background: var(--palette-ink-800);
  }
  .console-tabs button[aria-selected="true"] {
    background: linear-gradient(90deg, var(--palette-ink-900), color-mix(in oklch, var(--palette-cyan-400) 16%, var(--palette-ink-900)));
    color: var(--palette-cream-100);
    border-color: color-mix(in oklch, var(--palette-cyan-400) 55%, transparent);
    box-shadow: -6px 0 18px -8px var(--palette-cyan-400);
  }
  .console-tabs button[aria-selected="true"]::after {
    content: "";
    position: absolute;
    right: -1px;
    top: 15%;
    bottom: 15%;
    width: 3px;
    border-radius: 2px;
    background: var(--palette-cyan-400);
    box-shadow: 0 0 12px var(--palette-cyan-400);
  }
  .console-tabs button:focus-visible {
    outline: none;
    box-shadow: 0 0 0 2px var(--palette-cyan-400), 0 0 18px var(--palette-cyan-400);
  }
  .tab-label {
    font-family: var(--font-family-display);
    font-size: var(--typography_fluid-text-l);
    font-weight: var(--typography-weight-display-bold);
  }
  .tab-package {
    font-family: var(--font-family-mono);
    font-size: var(--typography_fluid-text-xs);
    color: var(--palette-acid-400);
  }
  .console-frame {
    padding: var(--spacing_fluid-space-2xs);
    border-radius: 0 var(--radius-size-l) var(--radius-size-l) var(--radius-size-l);
    background: linear-gradient(135deg, var(--palette-brass-200), var(--palette-brass-500) 40%, var(--palette-brass-700) 70%, var(--palette-brass-400));
    box-shadow:
      0 0 0 2px var(--palette-ink-900),
      0 30px 80px -30px color-mix(in oklch, var(--palette-cyan-400) 35%, transparent);
  }
  .console-screen {
    width: 100%;
    background: radial-gradient(circle at 20% 0%, var(--palette-blueprint-800), var(--palette-ink-925) 70%);
  }
  :deep(.bluescreen-canvas) {
    display: block;
    width: 100%;
  }
  .console-panel {
    padding: var(--spacing_fluid-space-m) var(--spacing_fluid-space-l);
  }
  .console-note {
    min-height: 2lh;
    margin: 0 0 var(--spacing_fluid-space-xs);
    font-family: var(--font-family-label);
    font-size: var(--typography_fluid-text-xs);
    letter-spacing: var(--font-tracking-label);
    text-transform: uppercase;
    color: var(--palette-cyan-400);
  }
  .console-code {
    font-size: var(--typography_fluid-text-xs);
    line-height: 1.5;
    min-height: 31lh;
  }
  .console-code :deep(pre) {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .console-source {
    display: inline-block;
    margin-top: var(--spacing_fluid-space-s);
    font-family: var(--font-family-mono);
    font-size: var(--typography_fluid-text-xs);
    color: var(--palette-brass-300);
  }
  @media (max-width: 760px) {
    .console {
      grid-template-columns: minmax(0, 1fr);
    }
    .console-frame {
      border-radius: var(--radius-size-l);
    }
    .console-tabs {
      display: grid;
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: var(--spacing_fluid-space-3xs);
      margin-bottom: var(--spacing_fluid-space-2xs);
    }
    .console-code {
      font-size: var(--typography_fluid-text-s);
    }
    .console-tabs button {
      flex: none;
      margin-right: 0;
      border-right: 1px solid color-mix(in oklch, var(--palette-brass-400) 30%, transparent);
      border-radius: var(--radius-size-m);
    }
    .console-tabs button[aria-selected="true"]::after {
      inset: auto 15% -1px;
      width: auto;
      height: 3px;
    }
    .console-note {
      min-height: 4lh;
    }
  }
</style>
