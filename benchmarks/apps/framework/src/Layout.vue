<script setup lang="ts" vapor>
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute } from "vue-router";
import { isSearchShortcut } from "framework/behaviors";
import { RouterView, usePage } from "framework/client";
import { useActiveHeading } from "./active-heading.ts";
import { data as groups } from "./sidebar.data.ts";
import Search from "./Search.vue";
import ThemeToggle from "./ThemeToggle.vue";

const searching = ref(false);
const menuOpen = ref(false);
const page = usePage();
const route = useRoute();
const active = useActiveHeading();

const links = groups.flatMap((group) => group.links);
const position = computed(() => links.findIndex((link) => link.href === page.value.path));
const previous = computed(() => (position.value > 0 ? links[position.value - 1] : undefined));
const next = computed(() => (position.value >= 0 ? links[position.value + 1] : undefined));

watch(
  () => route.path,
  () => {
    menuOpen.value = false;
  },
);

const onKey = (event: KeyboardEvent): void => {
  if (event.key === "Escape" && menuOpen.value) menuOpen.value = false;
  if (!isSearchShortcut(event)) return;
  event.preventDefault();
  searching.value = true;
};
onMounted(() => addEventListener("keydown", onKey));
onUnmounted(() => removeEventListener("keydown", onKey));
</script>

<template>
  <a class="skip-link" href="#content">Skip to content</a>
  <header class="nav">
    <button type="button" class="menu-button" aria-controls="sidebar" :aria-expanded="menuOpen ? 'true' : 'false'" @click="menuOpen = !menuOpen">
      <svg aria-hidden="true" viewBox="0 0 24 24"><path v-if="menuOpen" d="m6 6 12 12M18 6 6 18" /><path v-else d="M4 6h16M4 12h16M4 18h16" /></svg>
      <span class="sr-only">Menu</span>
    </button>
    <a class="brand" href="/">Example Docs</a>
    <nav class="nav-links" aria-label="Sections"><a href="/guide/">Guide</a> <a href="/reference/">Reference</a></nav>
    <button type="button" class="search-button" aria-keyshortcuts="Control+K /" @click="searching = true">
      <svg aria-hidden="true" viewBox="0 0 24 24"><circle cx="11" cy="11" r="7" /><path d="m20 20-4-4" /></svg>
      <span class="search-label">Search</span>
      <kbd aria-hidden="true">Ctrl K</kbd>
    </button>
    <ThemeToggle />
  </header>
  <Search :open="searching" @open="searching = true" @close="searching = false" />
  <div class="layout">
    <nav id="sidebar" class="sidebar" :class="{ open: menuOpen }" aria-label="Pages">
      <section v-for="group in groups" :key="group.label">
        <h2>{{ group.label }}</h2>
        <a v-for="link in group.links" :key="link.href" :href="link.href" :aria-current="page.path === link.href ? 'page' : undefined">{{ link.text }}</a>
      </section>
    </nav>
    <div class="content">
      <details v-if="page.headings.length > 0" :key="page.path" class="mobile-toc">
        <summary>On this page</summary>
        <a v-for="heading in page.headings" :key="heading.slug" :href="`#${heading.slug}`" :class="`level-${heading.level}`">{{ heading.title }}</a>
      </details>
      <main id="content" data-search><RouterView /></main>
      <nav v-if="previous || next" class="pagination" aria-label="Previous and next pages">
        <a v-if="previous" :href="previous.href" rel="prev"><span>Previous</span>{{ previous.text }}</a>
        <a v-if="next" :href="next.href" rel="next"><span>Next</span>{{ next.text }}</a>
      </nav>
    </div>
    <aside v-if="page.headings.length > 0" class="toc" aria-labelledby="toc-title">
      <h2 id="toc-title">On this page</h2>
      <a v-for="heading in page.headings" :key="heading.slug" :href="`#${heading.slug}`" :class="`level-${heading.level}`" :aria-current="active === heading.slug ? 'true' : undefined">{{ heading.title }}</a>
    </aside>
  </div>
</template>
