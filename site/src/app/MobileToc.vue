<script setup lang="ts" vapor>
import { computed, ref, watch } from "vue";
import type { TocEntry } from "./toc.ts";
import Caret from "../theme/Caret.vue";
import TocList from "./TocList.vue";

const props = defineProps<{ headers: readonly TocEntry[]; active: string }>();
const open = ref(false);
const titles = (headers: readonly TocEntry[]): [string, string][] => headers.flatMap((header) => [[header.slug, header.title], ...titles(header.children)]);
const current = computed(() => new Map(titles(props.headers)).get(props.active) ?? "Overview");
const toggled = (event: Event) => {
  if (event.target instanceof HTMLDetailsElement) open.value = event.target.open;
};
watch(
  () => props.active,
  () => {
    open.value = false;
  },
);
</script>

<template>
  <nav class="mobile-toc" aria-labelledby="mobile-toc-title">
    <details :open="open" @toggle="toggled">
      <summary id="mobile-toc-title">
        <span class="toggle">On this page<Caret /></span>
        <span class="display-current">{{ current }}</span>
      </summary>
      <div class="dropdown" @click="open = false">
        <TocList :headers="headers" :active="active" mobile overview />
      </div>
    </details>
  </nav>
</template>
