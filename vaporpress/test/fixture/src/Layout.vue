<script lang="ts">
import { defineLazyLayout } from "vaporpress/client";
import type { PageData } from "vaporpress/client";

const hasToc = (page: PageData): boolean => {
  Reflect.set(globalThis, "tocChecks", Number(Reflect.get(globalThis, "tocChecks") ?? 0) + 1);
  return page.frontmatter["toc"] === true;
};
const Toc = defineLazyLayout(() => import("./Toc.vue"), hasToc);
</script>

<script setup lang="ts" vapor>
import { onMounted } from "vue";
import { onPageUpdated, RouterView, usePage } from "vaporpress/client";
import Search from "./Search.vue";

const page = usePage();
onMounted(() => {
  document.body.dataset["mounted"] = `${document.body.dataset["mounted"] ?? ""}layout `;
});
onPageUpdated(() => {
  document.body.dataset["updatedFor"] = document.querySelector("h1")?.textContent ?? "";
});
</script>

<template>
  <a class="skip-link" href="#content">Skip to content</a>
  <header><a href="/">Home</a> <a href="/guide/">Guide</a> <a href="/guide/long/">Long</a> <a href="/guide/branches/">Branches</a></header>
  <Toc v-if="page.frontmatter.toc === true" :headings="page.headings" />
  <Search />
  <main id="content" :data-search="page.path === '/404' ? undefined : ''">
    <RouterView />
    <footer data-search-ignore>Footer words such as quuxfooter</footer>
  </main>
</template>
