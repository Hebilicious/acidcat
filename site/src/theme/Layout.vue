<script setup lang="ts">
import { useData } from "vitepress";
import DocsLayout from "./DocsLayout.vue";

const { page, frontmatter } = useData();
</script>

<template>
  <Content v-if="frontmatter.layout === 'home'" />
  <DocsLayout v-else :not-found="page.isNotFound || frontmatter.layout === 'not-found'" />
</template>
