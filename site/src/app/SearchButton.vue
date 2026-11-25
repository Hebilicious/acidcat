<script setup lang="ts" vapor>
import { computed, defineVaporAsyncComponent, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import type { LocationQuery } from "vue-router";
import { loadRouteStyles, prefetchRouteStyles } from "../theme/route-styles.ts";

const loadDialog = () => import("./SearchDialog.vue");
const SearchDialog = defineVaporAsyncComponent(loadDialog);
const route = useRoute();
const router = useRouter();

const searchKey = "search";
const mounted = ref(false);
const stylesLoaded = ref(false);
const wanted = computed(() => mounted.value && route.query[searchKey] !== undefined);
const open = computed(() => wanted.value && stylesLoaded.value);
let pushed = false;

watch(wanted, (isWanted) => {
  if (isWanted) {
    void loadRouteStyles("search").then(() => {
      stylesLoaded.value = true;
    });
  } else pushed = false;
});

const withoutSearch = (query: LocationQuery): LocationQuery => Object.fromEntries(Object.entries(query).filter(([key]) => key !== searchKey));

const show = (): void => {
  if (wanted.value) return;
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

const prefetch = (): void => {
  prefetchRouteStyles("search");
  void loadDialog();
};

const isTextField = (target: EventTarget | null): boolean =>
  target instanceof HTMLElement && (target.isContentEditable || target instanceof HTMLTextAreaElement || target instanceof HTMLSelectElement || (target instanceof HTMLInputElement && !["button", "checkbox", "radio", "reset", "submit"].includes(target.type)));

const shortcut = (event: KeyboardEvent): void => {
  const controlK = event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey);
  const slash = event.key === "/" && !event.ctrlKey && !event.metaKey && !event.altKey && !isTextField(event.target);
  if (!controlK && !slash) return;
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
  <button type="button" class="search-button" aria-label="Search" aria-keyshortcuts="Control+K /" @click="show" @pointerover="prefetch" @focus="prefetch">
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21.71 20.29 18 16.61A9 9 0 1 0 16.61 18l3.68 3.68a1 1 0 0 0 1.42 0 1 1 0 0 0 0-1.39ZM11 18a7 7 0 1 1 7-7 7 7 0 0 1-7 7Z" />
    </svg>
    <span class="search-label">Search</span>
  </button>
  <SearchDialog v-if="open" @close="close" @go="go" />
</template>
