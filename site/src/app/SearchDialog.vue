<script setup lang="ts" vapor>
import { computed, nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import { loadExcerpt, loadSearch, markTerms, markText } from "vaporpress/search";
import type { SearchResult, SiteSearch } from "vaporpress/search";

const emit = defineEmits<{ close: []; go: [path: string] }>();

interface ShownResult extends SearchResult {
  readonly titlesHtml: readonly string[];
  readonly titleHtml: string;
  readonly excerpt: string;
}

const readStorage = (storage: () => Storage, key: string): string | null => {
  try {
    return storage().getItem(key);
  } catch {
    return null;
  }
};
const writeStorage = (storage: () => Storage, key: string, value: string): void => {
  try {
    storage().setItem(key, value);
  } catch {
    // The browser keeps no storage for the page, for example in a private window.
  }
};

const queryKey = "acidcat:search-query";
const detailedKey = "acidcat:search-detailed";

const dialog = useTemplateRef<HTMLDialogElement>("dialog");
const input = useTemplateRef<HTMLInputElement>("input");
const list = useTemplateRef<HTMLElement>("list");

const query = ref(readStorage(() => sessionStorage, queryKey) ?? "");
const detailed = ref(readStorage(() => localStorage, detailedKey) === "true");
const engine = ref<SiteSearch>();
const failed = ref(false);
const results = ref<readonly ShownResult[]>([]);
const searched = ref(false);
const selected = ref(-1);
const pointerMoved = ref(false);
const loading = computed(() => engine.value === undefined && !failed.value);

let run = 0;
const search = async (): Promise<void> => {
  const current = ++run;
  const text = query.value.trim();
  const found = engine.value === undefined || text === "" ? [] : engine.value.search(text);
  const excerpts = detailed.value ? await Promise.all(found.map((result) => loadExcerpt(result.id).catch(() => ""))) : [];
  if (current !== run) return;
  results.value = found.map((result, index) => ({
    ...result,
    titlesHtml: result.titles.map((title) => markText(title, result.terms)),
    titleHtml: markText(result.title, result.terms),
    excerpt: markTerms(excerpts[index] ?? "", result.terms),
  }));
  searched.value = engine.value !== undefined;
  selected.value = results.value.length > 0 ? 0 : -1;
  await nextTick();
  for (const mark of dialog.value?.querySelectorAll(".excerpt mark:first-of-type") ?? []) mark.scrollIntoView({ block: "center" });
  list.value?.scrollTo({ top: 0 });
};

watch(query, () => {
  searched.value = false;
  writeStorage(() => sessionStorage, queryKey, query.value);
  void search();
});
watch(detailed, () => {
  writeStorage(() => localStorage, detailedKey, String(detailed.value));
  void search();
});

const showSelected = async (): Promise<void> => {
  await nextTick();
  dialog.value?.querySelector(".result.selected")?.scrollIntoView({ block: "nearest" });
};
const move = (step: number): void => {
  const count = results.value.length;
  if (count === 0) return;
  selected.value = (selected.value + step + count) % count;
  pointerMoved.value = false;
  void showSelected();
};

const close = (): void => emit("close");
const go = (result: ShownResult | undefined): void => {
  if (result !== undefined) emit("go", result.id);
};

const keydown = (event: KeyboardEvent): void => {
  if (event.key === "Escape") {
    event.preventDefault();
    close();
  } else if (event.key === "ArrowDown") {
    event.preventDefault();
    move(1);
  } else if (event.key === "ArrowUp") {
    event.preventDefault();
    move(-1);
  } else if (event.key === "Enter" && !event.isComposing && event.target instanceof HTMLInputElement) {
    event.preventDefault();
    go(results.value[selected.value]);
  }
};

const cancel = (event: Event): void => {
  event.preventDefault();
  close();
};

const hover = (index: number): void => {
  if (pointerMoved.value) selected.value = index;
};

const clear = (): void => {
  query.value = "";
  input.value?.focus();
};

const toggleDetails = (): void => {
  detailed.value = !detailed.value;
};

let returnFocus: Element | null = null;

onMounted(() => {
  returnFocus = document.activeElement;
  document.documentElement.dataset["searchOpen"] = "";
  dialog.value?.showModal();
  input.value?.focus();
  input.value?.select();
  loadSearch().then(
    (loaded) => {
      engine.value = loaded;
      void search();
    },
    () => {
      failed.value = true;
    },
  );
});

onBeforeUnmount(() => {
  dialog.value?.close();
  delete document.documentElement.dataset["searchOpen"];
  if (returnFocus instanceof HTMLElement) returnFocus.focus();
});
</script>

<template>
  <dialog ref="dialog" class="search-dialog" aria-labelledby="search-label" @keydown="keydown" @cancel="cancel">
    <div class="search-backdrop" @click="close" />
    <div class="search-shell">
      <form class="search-bar" @submit.prevent>
        <label id="search-label" for="search-input" title="Search">
          <svg class="search-icon" aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
          <span class="sr-only">Search</span>
        </label>
        <button type="button" class="search-action search-back" aria-label="Close search" title="Close search" @click="close">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M19 12H5M12 19l-7-7 7-7" /></svg>
        </button>
        <input
          id="search-input"
          ref="input"
          v-model="query"
          class="search-input"
          type="search"
          role="combobox"
          placeholder="Search"
          autocapitalize="off"
          autocomplete="off"
          spellcheck="false"
          enterkeyhint="go"
          maxlength="64"
          aria-autocomplete="list"
          :aria-expanded="results.length > 0 ? 'true' : 'false'"
          :aria-controls="results.length > 0 ? 'search-results' : undefined"
          :aria-activedescendant="selected > -1 ? `search-result-${selected}` : undefined"
        />
        <span class="search-loading" :class="{ active: loading }" :role="loading ? 'status' : undefined" :aria-label="loading ? 'Loading the search' : undefined" />
        <button type="button" class="search-action" :class="{ on: detailed }" aria-label="Display detailed list" title="Display detailed list" :aria-pressed="detailed" @click="toggleDetails">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M3 5h4M3 12h4M3 19h4M11 5h10M11 12h10M11 19h10" /></svg>
        </button>
        <button type="button" class="search-action" aria-label="Reset search" title="Reset search" :disabled="query === ''" @click="clear">
          <svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 5H9l-7 7 7 7h11a2 2 0 0 0 2-2V7a2 2 0 0 0-2-2ZM18 9l-6 6M12 9l6 6" /></svg>
        </button>
      </form>

      <ul v-if="results.length > 0" id="search-results" ref="list" class="search-results" role="listbox" aria-label="Results" @pointermove="pointerMoved = true">
        <li
          v-for="(result, index) in results"
          :id="`search-result-${index}`"
          :key="result.id"
          class="result"
          :class="{ selected: selected === index }"
          role="option"
          :aria-selected="selected === index ? 'true' : 'false'"
          @pointerenter="hover(index)"
          @click="go(result)"
        >
          <span class="result-titles">
            <span class="result-mark" aria-hidden="true">#</span>
            <span v-for="(title, part) in result.titlesHtml" :key="part" class="result-title">
              <span v-html="title" />
              <svg aria-hidden="true" viewBox="0 0 24 24"><path d="m9 18 6-6-6-6" /></svg>
            </span>
            <span class="result-title main" v-html="result.titleHtml" />
          </span>
          <span v-if="detailed && result.excerpt !== ''" class="excerpt markdown-content" inert v-html="result.excerpt" />
        </li>
      </ul>
      <p v-if="failed" class="no-results">The search did not load. Close it and try again.</p>
      <p v-else-if="query.trim() !== '' && results.length === 0 && searched" class="no-results">No results for "<strong>{{ query }}</strong>"</p>

      <div class="search-keys">
        <span>
          <kbd><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 19V5M5 12l7-7 7 7" /></svg><span class="sr-only">Up arrow</span></kbd>
          <kbd><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M12 5v14M19 12l-7 7-7-7" /></svg><span class="sr-only">Down arrow</span></kbd>
          to navigate
        </span>
        <span>
          <kbd><svg aria-hidden="true" viewBox="0 0 24 24"><path d="M20 4v7a4 4 0 0 1-4 4H4M9 10l-5 5 5 5" /></svg><span class="sr-only">Enter</span></kbd>
          to select
        </span>
        <span><kbd>esc</kbd> to close</span>
      </div>
    </div>
  </dialog>
</template>

<style>
  :root[data-search-open] {
    overflow: hidden;
  }

  .search-dialog {
    position: fixed;
    inset: 0;
    width: 100%;
    max-width: none;
    height: 100%;
    max-height: none;
    margin: 0;
    padding: 0;
    overflow: hidden;
    border: 0;
    background: none;
    color: var(--palette-cream-100);
    font-family: var(--font-family-sans);
  }

  .search-dialog[open] {
    display: flex;
  }

  .search-dialog::backdrop {
    background: none;
  }

  .search-backdrop {
    position: absolute;
    inset: 0;
    background: color-mix(in oklch, var(--palette-ink-950) 80%, transparent);
  }

  .search-shell {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: var(--spacing_fluid-space-s);
    width: min(100vw - var(--spacing_fluid-space-2xl), var(--layout-width-content));
    height: min-content;
    max-height: calc(100vh - 2 * var(--spacing_fluid-space-2xl));
    margin: var(--spacing_fluid-space-2xl) auto;
    padding: var(--spacing_fluid-space-s);
    border: 1px solid color-mix(in oklch, var(--palette-brass-400) 30%, transparent);
    border-radius: var(--radius-size-m);
    background: var(--palette-ink-900);
    box-shadow: 0 var(--spacing_fluid-space-s) var(--spacing_fluid-space-2xl) var(--palette-ink-950);
  }

  .search-dialog :is(button, input) {
    color: inherit;
    font: inherit;
    background: none;
    border: 0;
  }

  .search-dialog svg {
    flex: none;
    width: 1.125em;
    height: 1.125em;
    fill: none;
    stroke: currentColor;
    stroke-width: 2;
    stroke-linecap: round;
    stroke-linejoin: round;
  }

  .search-bar {
    display: flex;
    align-items: center;
    gap: var(--spacing_fluid-space-2xs);
    min-height: var(--spacing_fluid-space-xl);
    padding-inline: var(--spacing_fluid-space-xs);
    border: 1px solid color-mix(in oklch, var(--palette-brass-400) 30%, transparent);
    border-radius: var(--radius-size-m);
    background: var(--palette-ink-950);
    cursor: text;
  }

  .search-bar:focus-within {
    border-color: var(--palette-acid-400);
    box-shadow: 0 0 var(--spacing_fluid-space-s) color-mix(in oklch, var(--palette-acid-400) 25%, transparent);
  }

  .search-icon {
    display: block;
    color: var(--palette-acid-400);
  }

  /* The search bar shows the focus of its input with its border, so the input draws no outline of its own. */
  .search-input {
    flex: 1;
    min-width: 0;
    padding: var(--spacing_fluid-space-2xs) var(--spacing_fluid-space-3xs);
    font-size: var(--typography_fluid-text-m);
    outline: none;
  }

  .search-input::-webkit-search-cancel-button {
    display: none;
  }

  .search-input::placeholder {
    color: var(--palette-cream-400);
    opacity: 1;
  }

  .search-action {
    display: flex;
    padding: var(--spacing_fluid-space-2xs);
    border-radius: var(--radius-size-s);
    color: var(--palette-cream-400);
    cursor: pointer;
  }

  .search-action:focus-visible {
    outline: 2px solid var(--palette-acid-400);
    outline-offset: -2px;
  }

  .search-action:not([disabled]):hover,
  .search-action.on {
    color: var(--palette-acid-400);
  }

  .search-action:disabled {
    opacity: 0.37;
    cursor: default;
  }

  .search-back {
    display: none;
  }

  .search-loading {
    flex: none;
    visibility: hidden;
    width: 1.125em;
    height: 1.125em;
    border: 2px solid color-mix(in oklch, var(--palette-brass-400) 30%, transparent);
    border-top-color: var(--palette-acid-400);
    border-radius: 50%;
  }

  .search-loading.active {
    visibility: visible;
    animation: search-loading 0.8s linear infinite;
  }

  @media (prefers-reduced-motion: reduce) {
    .search-loading.active {
      animation: none;
    }
  }

  @keyframes search-loading {
    to {
      transform: rotate(360deg);
    }
  }

  .search-results {
    display: flex;
    flex-direction: column;
    gap: var(--spacing_fluid-space-2xs);
    margin: 0;
    padding: 0;
    overflow-x: hidden;
    overflow-y: auto;
    overscroll-behavior: contain;
    list-style: none;
  }

  .result {
    display: flex;
    cursor: pointer;
    flex-direction: column;
    gap: var(--spacing_fluid-space-3xs);
    padding: var(--spacing_fluid-space-xs);
    border: 1px solid color-mix(in oklch, var(--palette-brass-400) 20%, transparent);
    border-radius: var(--radius-size-s);
    background: var(--palette-ink-800);
    color: inherit;
    font-size: var(--typography_fluid-text-s);
    line-height: 1;
  }

  .result.selected {
    border-color: var(--palette-acid-400);
    background: color-mix(in oklch, var(--palette-acid-400) 8%, var(--palette-ink-800));
    box-shadow: 0 0 var(--spacing_fluid-space-xs) color-mix(in oklch, var(--palette-acid-400) 20%, transparent);
  }

  .result-titles {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing_fluid-space-3xs);
    padding-block: var(--spacing_fluid-space-3xs);
  }

  .result.selected .result-titles {
    color: var(--palette-acid-400);
  }

  .result-title {
    display: flex;
    align-items: center;
    gap: var(--spacing_fluid-space-3xs);
  }

  .result-title svg {
    opacity: 0.5;
  }

  .result-title.main,
  .result-mark {
    font-weight: var(--typography-weight-display-medium);
  }

  .result-mark {
    color: var(--palette-brass-400);
  }

  .result.selected .result-mark {
    color: var(--palette-acid-400);
  }

  .search-dialog mark {
    padding-inline: var(--spacing_fluid-space-3xs);
    border-radius: var(--radius-size-s);
    background: var(--palette-acid-400);
    color: var(--palette-ink-900);
  }

  .excerpt {
    max-height: 8.75rem;
    overflow: hidden;
    opacity: 0.5;
    pointer-events: none;
    font-size: var(--typography_fluid-text-xs);
    line-height: 1.3;
  }

  .excerpt * {
    font-size: inherit;
  }

  .result.selected .excerpt {
    opacity: 1;
  }

  .no-results {
    padding: var(--spacing_fluid-space-l) var(--spacing_fluid-space-s);
    border: 1px dashed color-mix(in oklch, var(--palette-brass-400) 30%, transparent);
    border-radius: var(--radius-size-s);
    color: var(--palette-cream-400);
    font-size: var(--typography_fluid-text-s);
    text-align: center;
  }

  .no-results strong {
    color: var(--palette-acid-400);
  }

  .search-keys {
    display: flex;
    flex-wrap: wrap;
    gap: var(--spacing_fluid-space-s);
    color: var(--palette-cream-400);
    font-size: var(--typography_fluid-text-xs);
  }

  .search-keys kbd svg {
    width: 0.875em;
    height: 0.875em;
  }

  .search-keys span {
    display: flex;
    align-items: center;
    gap: var(--spacing_fluid-space-3xs);
  }

  .search-keys kbd {
    display: inline-flex;
    justify-content: center;
    min-width: 1.5em;
    padding: var(--spacing_fluid-space-3xs) var(--spacing_fluid-space-2xs);
    border: 1px solid color-mix(in oklch, var(--palette-brass-400) 30%, transparent);
    border-radius: var(--radius-size-s);
    background: var(--palette-ink-800);
    color: var(--palette-cream-100);
    font-family: var(--font-family-mono);
    text-align: center;
  }

  @media not all and (min-width: 48rem) {
    .search-shell {
      width: 100vw;
      height: 100vh;
      max-height: none;
      margin: 0;
      border: 0;
      border-radius: 0;
      box-shadow: none;
    }

    .search-icon,
    .search-keys {
      display: none;
    }

    .search-back {
      display: flex;
    }
  }
</style>
