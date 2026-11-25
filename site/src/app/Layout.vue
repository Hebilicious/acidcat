<script lang="ts">
import { defineLazyLayout } from "vaporpress/client";
import type { PageData } from "vaporpress/client";

const isHomePage = (page: PageData): boolean => page.frontmatter["layout"] === "home";
/** The homepage does not use the layout of the docs, so it is a chunk of its own. */
const DocsLayout = defineLazyLayout(() => import("./DocsLayout.vue"), (page) => !isHomePage(page));
</script>

<script setup lang="ts" vapor>
import { computed } from "vue";
import { RouterView, usePage } from "vaporpress/client";

const page = usePage();
const home = computed(() => isHomePage(page.value));
</script>

<template>
  <RouterView v-if="home" />
  <DocsLayout v-else />
</template>
