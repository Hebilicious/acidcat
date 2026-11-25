<script setup lang="ts" vapor>
import { ref } from "vue";
import { loadExcerpt, loadSearch, markText } from "vaporpress/search";
import type { SearchResult } from "vaporpress/search";

const results = ref<readonly SearchResult[]>([]);
const excerpt = ref("");

const find = async (event: Event): Promise<void> => {
  if (!(event.target instanceof HTMLInputElement)) return;
  const search = await loadSearch();
  results.value = search.search(event.target.value);
  const first = results.value[0];
  excerpt.value = first === undefined ? "" : await loadExcerpt(first.id);
};
</script>

<template>
  <input class="search" type="search" aria-label="Search" @input="find" />
  <ul class="search-results">
    <li v-for="result in results" :key="result.id"><a :href="result.id" :data-titles="result.titles.join(' > ')" v-html="markText(result.title, result.terms)" /></li>
  </ul>
  <div class="search-excerpt" v-html="excerpt" />
</template>
