<script setup lang="ts" vapor>
import { nextTick, onBeforeUnmount, onMounted, ref, useTemplateRef, watch } from "vue";
import { useRouter } from "vue-router";
import { loadExcerpt, loadSearch, markText } from "framework/search";
import type { SearchResult, SiteSearch } from "framework/search";
import { excerptAround } from "./excerpt.ts";

const emit = defineEmits<{ close: [] }>();

interface ShownResult extends SearchResult {
  readonly titleHtml: string;
  readonly section: string;
  readonly excerpt: string;
}

const router = useRouter();
const dialog = useTemplateRef<HTMLDialogElement>("dialog");
const input = useTemplateRef<HTMLInputElement>("input");
const query = ref("");
const engine = ref<SiteSearch>();
const results = ref<readonly ShownResult[]>([]);
const searched = ref(false);
const selected = ref(-1);

let run = 0;
const search = async (): Promise<void> => {
  const current = ++run;
  const text = query.value.trim();
  const found = engine.value === undefined || text === "" ? [] : engine.value.search(text, 10);
  const excerpts = await Promise.all(found.map((result) => loadExcerpt(result.id).catch(() => "")));
  if (current !== run) return;
  results.value = found.map((result, index) => ({
    ...result,
    titleHtml: markText(result.title, result.terms),
    section: result.titles.join(" › "),
    excerpt: excerptAround(excerpts[index] ?? "", result.terms),
  }));
  searched.value = engine.value !== undefined;
  selected.value = results.value.length > 0 ? 0 : -1;
};
watch(query, () => void search());

const go = (result: ShownResult | undefined): void => {
  if (result === undefined) return;
  emit("close");
  void router.push(result.id);
};

const move = async (step: number): Promise<void> => {
  const count = results.value.length;
  if (count === 0) return;
  selected.value = (selected.value + step + count) % count;
  await nextTick();
  dialog.value?.querySelector('[aria-selected="true"]')?.scrollIntoView({ block: "nearest" });
};

const keydown = (event: KeyboardEvent): void => {
  if (event.key === "ArrowDown" || event.key === "ArrowUp") {
    event.preventDefault();
    void move(event.key === "ArrowDown" ? 1 : -1);
  } else if (event.key === "Enter" && !event.isComposing) {
    event.preventDefault();
    go(results.value[selected.value]);
  }
};

const closeOnBackdrop = (event: MouseEvent): void => {
  if (event.target === dialog.value) emit("close");
};

let returnFocus: Element | null = null;
onMounted(() => {
  returnFocus = document.activeElement;
  dialog.value?.showModal();
  input.value?.focus();
  void loadSearch().then((loaded) => {
    engine.value = loaded;
    void search();
  });
});
onBeforeUnmount(() => {
  if (returnFocus instanceof HTMLElement) returnFocus.focus();
});
</script>

<template>
  <dialog ref="dialog" class="search" aria-label="Search" @close="emit('close')" @click="closeOnBackdrop">
    <div class="search-panel">
      <input
        ref="input"
        v-model="query"
        type="search"
        role="combobox"
        placeholder="Search the docs"
        aria-label="Search"
        autocomplete="off"
        spellcheck="false"
        aria-autocomplete="list"
        :aria-expanded="results.length > 0 ? 'true' : 'false'"
        :aria-controls="results.length > 0 ? 'search-results' : undefined"
        :aria-activedescendant="selected > -1 ? `search-result-${selected}` : undefined"
        @keydown="keydown"
      />
      <ul v-if="results.length > 0" id="search-results" role="listbox" aria-label="Results">
        <li
          v-for="(result, index) in results"
          :id="`search-result-${index}`"
          :key="result.id"
          role="option"
          :aria-selected="selected === index ? 'true' : 'false'"
          @pointerenter="selected = index"
          @click="go(result)"
        >
          <span v-if="result.section !== ''" class="result-section">{{ result.section }}</span>
          <span class="result-title" v-html="result.titleHtml" />
          <span v-if="result.excerpt !== ''" class="result-excerpt" v-html="result.excerpt" />
        </li>
      </ul>
      <p v-if="query.trim() !== '' && results.length === 0 && searched" class="no-results">No results for “{{ query }}”</p>
      <p class="search-keys"><kbd>↑</kbd> <kbd>↓</kbd> to move, <kbd>Enter</kbd> to open, <kbd>Esc</kbd> to close</p>
    </div>
  </dialog>
</template>
