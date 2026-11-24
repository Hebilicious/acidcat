<script setup lang="ts" vapor>
import { RouterView, usePage } from "acid-cat-site-framework/client";

const page = usePage();
</script>

<template>
  <a class="skip-link" href="#content">Skip to content</a>
  <header><a href="/">Home</a> <a href="/guide/">Guide</a> <a href="/guide/long/">Long</a> <a href="/guide/branches/">Branches</a></header>
  <aside v-if="page.headings.length > 0" class="toc">
    <a v-for="heading in page.headings" :key="heading.slug" :href="`#${heading.slug}`">{{ heading.title }}</a>
  </aside>
  <main id="content"><RouterView /></main>
</template>
