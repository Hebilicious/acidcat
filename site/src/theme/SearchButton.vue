<script setup lang="ts">
import { defineAsyncComponent, onMounted, onUnmounted, ref } from "vue";

const SearchBox = defineAsyncComponent(() => import("vitepress/dist/client/theme-default/components/VPLocalSearchBox.vue"));
const open = ref(false);
const shortcut = (event: KeyboardEvent) => {
  if (event.key.toLowerCase() === "k" && (event.ctrlKey || event.metaKey)) {
    event.preventDefault();
    open.value = true;
  }
};
onMounted(() => window.addEventListener("keydown", shortcut));
onUnmounted(() => window.removeEventListener("keydown", shortcut));
</script>

<template>
  <button type="button" class="search-button" aria-label="Search" aria-keyshortcuts="Control+K" @click="open = true">
    <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
      <path d="M21.71 20.29 18 16.61A9 9 0 1 0 16.61 18l3.68 3.68a1 1 0 0 0 1.42 0 1 1 0 0 0 0-1.39ZM11 18a7 7 0 1 1 7-7 7 7 0 0 1-7 7Z" />
    </svg>
    <span class="search-label">Search</span>
  </button>
  <SearchBox v-if="open" @close="open = false" />
</template>
