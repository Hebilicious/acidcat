<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { packageGroups } from "../lib/package-groups.ts";
import { copyInstallCommands, showLiveVersions } from "../lib/packages-page.ts";
import { data } from "./packages.data.ts";

const repository = "https://github.com/Hebilicious/acidcat";
const groups = packageGroups.map((group) => ({ ...group, members: data.filter((entry) => entry.kind === group.kind) })).filter((group) => group.members.length > 0);

const root = ref<HTMLElement>();
const lifetime = new AbortController();
onMounted(() => {
  if (root.value === undefined) return;
  copyInstallCommands(root.value, lifetime.signal);
  showLiveVersions(root.value, lifetime.signal);
});
onUnmounted(() => lifetime.abort());
</script>

<template>
  <div ref="root" class="packages-page">
    <p class="packages-lede">
      This list comes from the release configuration of the repository, so a new package appears here when it is released. The version on each card is the released version in the repository; the page also asks each registry for its latest version.
    </p>

    <section v-for="group in groups" :key="group.kind" class="package-group" :aria-labelledby="`group-${group.kind}`">
      <h2 :id="`group-${group.kind}`">{{ group.title }}</h2>
      <p>{{ group.text }}</p>
      <ul class="package-list">
        <li v-for="entry in group.members" :key="entry.name + entry.registry" class="package-card" :data-registry="entry.registry" :data-latest="entry.latest" :data-version="entry.version">
          <div class="package-head">
            <span class="package-registry">{{ entry.registry }}</span>
            <span class="package-version" data-live-version>v{{ entry.version }}</span>
          </div>
          <h3><a :href="entry.url" target="_blank" rel="noopener noreferrer">{{ entry.title }}</a></h3>
          <p v-if="entry.title !== entry.name" class="package-name" :title="entry.name">{{ entry.name }}</p>
          <p class="package-description">{{ entry.description }}</p>
          <div class="package-install">
            <pre><code>{{ entry.install }}</code></pre>
            <button type="button" class="package-copy" :data-copy="entry.install" :aria-label="`Copy ${entry.install}`">
              <svg viewBox="0 0 24 24" aria-hidden="true"><rect x="8" y="8" width="12" height="12" rx="2" /><path d="M16 8V6a2 2 0 0 0-2-2H6a2 2 0 0 0-2 2v8a2 2 0 0 0 2 2h2" /></svg>
              <span data-copy-label>Copy</span>
            </button>
          </div>
          <p class="package-meta">
            <a :href="`${repository}/tree/main/${entry.directory}`" target="_blank" rel="noopener noreferrer">Source</a>
            <span data-live-status aria-live="polite"></span>
          </p>
        </li>
      </ul>
    </section>
  </div>
</template>

<style scoped>
  .packages-lede {
    max-width: 62ch;
  }
  .package-group {
    margin-top: var(--spacing_fluid-space-xl);
  }
  .package-list {
    list-style: none;
    margin: var(--spacing_fluid-space-m) 0 0;
    padding: 0;
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 19rem), 1fr));
    gap: var(--spacing_fluid-space-s);
  }
  .package-card {
    display: flex;
    flex-direction: column;
    gap: var(--spacing_fluid-space-2xs);
    margin: 0;
    padding: var(--spacing_fluid-space-s) var(--spacing_fluid-space-m);
    border: 1px solid color-mix(in oklch, var(--palette-brass-400) 30%, transparent);
    border-radius: var(--radius-size-m);
    background: linear-gradient(180deg, var(--palette-ink-800), var(--palette-ink-925));
    min-width: 0;
  }
  .package-head {
    display: flex;
    justify-content: space-between;
    align-items: center;
    gap: var(--spacing_fluid-space-xs);
    margin: 0;
  }
  .package-registry {
    font-family: var(--font-family-label);
    font-size: var(--typography_fluid-text-xs);
    letter-spacing: var(--font-tracking-label);
    text-transform: uppercase;
    color: var(--palette-cyan-400);
  }
  .package-version {
    font-family: var(--font-family-mono);
    font-size: var(--typography_fluid-text-xs);
    color: var(--palette-acid-400);
  }
  .package-card h3 {
    margin: 0;
    font-size: var(--typography_fluid-text-l);
    overflow-wrap: anywhere;
  }
  .package-card h3 a {
    color: var(--palette-cream-100);
    text-decoration: none;
  }
  .package-card h3 a:hover {
    color: var(--palette-acid-400);
  }
  .package-name {
    margin: 0;
    overflow: hidden;
    font-family: var(--font-family-mono);
    font-size: var(--typography_fluid-text-xs);
    color: color-mix(in oklch, var(--palette-cream-400) 80%, transparent);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .package-description {
    margin: 0;
    color: var(--palette-cream-400);
    font-size: var(--typography_fluid-text-s);
  }
  .package-install {
    display: flex;
    align-items: stretch;
    margin-top: auto;
    border-left: 2px solid var(--palette-brass-600);
    background: var(--palette-ink-950);
  }
  .package-install pre {
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: var(--spacing_fluid-space-2xs) var(--spacing_fluid-space-xs);
    border: 0;
    border-radius: 0;
    background: transparent;
    font-size: var(--typography_fluid-text-xs);
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .package-copy {
    flex: none;
    align-self: center;
    margin: var(--spacing_fluid-space-3xs);
    display: inline-flex;
    align-items: center;
    gap: var(--spacing_fluid-space-3xs);
    padding: var(--spacing_fluid-space-3xs) var(--spacing_fluid-space-xs);
    border: 1px solid color-mix(in oklch, var(--palette-brass-400) 40%, transparent);
    border-radius: var(--radius-size-s);
    background: var(--palette-ink-800);
    color: var(--palette-brass-200);
    font-family: var(--font-family-label);
    font-size: var(--typography_fluid-text-xs);
    cursor: pointer;
    transition: color 0.2s, border-color 0.2s;
  }
  .package-copy:hover,
  .package-copy:focus-visible {
    color: var(--palette-acid-200);
    border-color: var(--palette-acid-400);
  }
  .package-copy[data-copied] {
    color: var(--palette-acid-400);
  }
  .package-copy svg {
    width: 1em;
    height: 1em;
    fill: none;
    stroke: currentColor;
    stroke-width: 1.8;
    stroke-linecap: round;
    stroke-linejoin: round;
  }
  .package-meta {
    display: flex;
    justify-content: space-between;
    gap: var(--spacing_fluid-space-xs);
    margin: 0;
    font-size: var(--typography_fluid-text-xs);
    color: var(--palette-cream-400);
  }
</style>
