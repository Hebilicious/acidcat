<script setup lang="ts" vapor>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { isSearchShortcut } from "vaporpress/behaviors";
import type { LocationQuery } from "vue-router";
import SearchDialog from "./SearchDialog.vue";

const route = useRoute();
const router = useRouter();

const searchKey = "search";
const mounted = ref(false);
const open = computed(() => mounted.value && route.query[searchKey] !== undefined);
let pushed = false;

watch(open, (isOpen) => {
  if (!isOpen) pushed = false;
});

const withoutSearch = (query: LocationQuery): LocationQuery => Object.fromEntries(Object.entries(query).filter(([key]) => key !== searchKey));

const show = (): void => {
  if (open.value) return;
  pushed = true;
  void router.push({ path: route.path, query: { ...route.query, [searchKey]: null }, hash: route.hash });
};
const close = (): void => {
  if (pushed) router.back();
  else void router.replace({ path: route.path, query: withoutSearch(route.query), hash: route.hash });
};
const go = (path: string): void => {
  pushed = false;
  void router.replace(path);
};

const shortcut = (event: KeyboardEvent): void => {
  if (!isSearchShortcut(event)) return;
  event.preventDefault();
  show();
};
onMounted(() => {
  mounted.value = true;
  window.addEventListener("keydown", shortcut);
});
onUnmounted(() => window.removeEventListener("keydown", shortcut));
</script>

<template>
  <button type="button" class="search-button" aria-label="Search" aria-keyshortcuts="Control+K /" @click="show">
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21.71 20.29 18 16.61A9 9 0 1 0 16.61 18l3.68 3.68a1 1 0 0 0 1.42 0 1 1 0 0 0 0-1.39ZM11 18a7 7 0 1 1 7-7 7 7 0 0 1-7 7Z" />
    </svg>
    <span class="search-label">Search</span>
  </button>
  <SearchDialog :open="open" @open="show" @close="close" @go="go" />
</template>
