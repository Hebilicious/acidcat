<script setup lang="ts" vapor>
import { onPageUpdated, RouterView, usePage } from "framework/client";
import { data as groups } from "./sidebar.data.ts";
import { mountTabs } from "./tabs.ts";

const page = usePage();
onPageUpdated(() => {
  const content = document.getElementById("content");
  if (content !== null) mountTabs(content);
});
</script>

<template>
  <header class="nav"><a class="brand" href="/">Example Docs</a> <a href="/guide/">Guide</a> <a href="/reference/">Reference</a></header>
  <div class="layout">
    <nav class="sidebar" aria-label="Pages">
      <section v-for="group in groups" :key="group.label">
        <h2>{{ group.label }}</h2>
        <a v-for="link in group.links" :key="link.href" :href="link.href" :aria-current="page.path === link.href ? 'page' : undefined">{{ link.text }}</a>
      </section>
    </nav>
    <main id="content"><RouterView /></main>
    <aside v-if="page.headings.length > 0" class="toc" aria-label="On this page">
      <h2>On this page</h2>
      <a v-for="heading in page.headings" :key="heading.slug" :href="`#${heading.slug}`" :class="`level-${heading.level}`">{{ heading.title }}</a>
    </aside>
  </div>
</template>
