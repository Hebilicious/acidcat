<script setup lang="ts" vapor>
import { onMounted, ref, useTemplateRef } from "vue";
import { useRouter } from "vue-router";
import { loadSearch } from "framework/search";
import type { SearchResult } from "framework/search";

const emit = defineEmits<{ close: [] }>();
const router = useRouter();
const dialog = useTemplateRef<HTMLDialogElement>("dialog");
const results = ref<readonly SearchResult[]>([]);
const search = loadSearch();

const find = async (event: Event): Promise<void> => {
  const query = event.target instanceof HTMLInputElement ? event.target.value : "";
  results.value = query === "" ? [] : (await search).search(query, 10);
};
const go = (id: string): void => {
  emit("close");
  void router.push(id);
};
onMounted(() => dialog.value?.showModal());
</script>

<template>
  <dialog ref="dialog" class="search" aria-label="Search" @close="emit('close')">
    <input type="search" placeholder="Search" aria-label="Search" @input="find" />
    <ul>
      <li v-for="result in results" :key="result.id"><a :href="result.id" @click.prevent="go(result.id)">{{ result.title }}</a></li>
    </ul>
  </dialog>
</template>
