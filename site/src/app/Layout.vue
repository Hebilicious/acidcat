<script setup lang="ts" vapor>
import { computed, defineVaporAsyncComponent } from "vue";
import { RouterView, usePage } from "vaporpress/client";
import { isHomePage, loadDocsLayout } from "./docs-layout.ts";

const DocsLayout = defineVaporAsyncComponent(loadDocsLayout);
const page = usePage();
const home = computed(() => isHomePage(page.value));
</script>

<template>
  <RouterView v-if="home" />
  <DocsLayout v-else />
</template>
