<script setup lang="ts" vapor>
import { onMounted } from "vue";
import type { Heading } from "vaporpress/client";

defineProps<{ headings: readonly Heading[] }>();
onMounted(() => {
  document.body.dataset["mounted"] = `${document.body.dataset["mounted"] ?? ""}toc `;
});
</script>

<template>
  <aside class="toc">
    <a v-for="heading in headings" :key="heading.slug" :href="`#${heading.slug}`">{{ heading.title }}</a>
  </aside>
</template>
