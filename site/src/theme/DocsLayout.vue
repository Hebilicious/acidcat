<script setup lang="ts">
import { computed, ref, watch } from "vue";
import { useData, useRoute } from "vitepress";
import { siteUrl } from "../lib/social.ts";
import { useActiveHeading } from "./active-heading.ts";
import { usePageBehaviors } from "./page-behaviors.ts";
import MobileToc from "./MobileToc.vue";
import PageActions from "./PageActions.vue";
import Pagination from "./Pagination.vue";
import SearchButton from "./SearchButton.vue";
import Sidebar from "./Sidebar.vue";
import SiteNav from "./SiteNav.vue";
import TocList from "./TocList.vue";
import { flatLinks } from "./site-theme.ts";
import type { SiteTheme } from "./site-theme.ts";

const props = defineProps<{ notFound?: boolean }>();
const { page, frontmatter, theme } = useData<SiteTheme>();
const route = useRoute();

const section = computed(() => (props.notFound ? undefined : theme.value.sections.find((candidate) => route.path.startsWith(candidate.prefix))));
const headers = computed(() => page.value.headers);
const hasToc = computed(() => !props.notFound && frontmatter.value["tableOfContents"] !== false);
const title = computed(() => (props.notFound ? "404" : page.value.title));

const editUrl = computed(() => {
  if (props.notFound || frontmatter.value["editLink"] === false) return undefined;
  const source = frontmatter.value["source"];
  return `${theme.value.editBase}${typeof source === "string" ? source : `site/content/${page.value.filePath}`}`;
});
const issueUrl = computed(() => {
  const url = new URL("https://github.com/Hebilicious/acidcat/issues/new");
  url.searchParams.set("title", `Site: ${page.value.title}`);
  url.searchParams.set("body", `Page: ${siteUrl}${route.path}\n\n`);
  return url.href;
});

const links = computed(() => (section.value === undefined ? [] : flatLinks(section.value.items)));
const position = computed(() => links.value.findIndex((link) => link.link === route.path));
const previous = computed(() => (position.value > 0 ? links.value[position.value - 1] : undefined));
const next = computed(() => (position.value >= 0 ? links.value[position.value + 1] : undefined));

const menuOpen = ref(false);
watch(
  () => route.path,
  () => {
    menuOpen.value = false;
  },
);

const active = useActiveHeading();
usePageBehaviors();
</script>

<template>
  <div class="page" :data-has-sidebar="section ? '' : undefined" :data-has-toc="hasToc ? '' : undefined" :data-menu-open="menuOpen ? '' : undefined" :data-not-found="notFound ? '' : undefined" :data-section="section?.prefix.slice(1, -1)">
    <a class="skip-link" href="#_top">Skip to content</a>
    <header class="header">
      <SiteNav>
        <template #search><SearchButton /></template>
      </SiteNav>
    </header>
    <template v-if="section">
      <button type="button" class="menu-button" :aria-expanded="menuOpen" aria-controls="site-sidebar" @click="menuOpen = !menuOpen">
        <svg v-if="!menuOpen" aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M3 8h18a1 1 0 1 0 0-2H3a1 1 0 0 0 0 2Zm18 8H3a1 1 0 0 0 0 2h18a1 1 0 0 0 0-2Zm0-5H3a1 1 0 0 0 0 2h18a1 1 0 0 0 0-2Z" /></svg>
        <svg v-else aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="m13.41 12 6.3-6.29a1.004 1.004 0 1 0-1.42-1.42L12 10.59l-6.29-6.3a1.004 1.004 0 0 0-1.42 1.42l6.3 6.29-6.3 6.29a1 1 0 0 0 0 1.42.998.998 0 0 0 1.42 0l6.29-6.3 6.29 6.3a.999.999 0 0 0 1.42 0 1 1 0 0 0 0-1.42L13.41 12Z" /></svg>
        <span class="sr-only">Menu</span>
      </button>
      <nav id="site-sidebar" class="sidebar-pane" aria-label="Main">
        <div class="sidebar-content"><Sidebar :section="section" /></div>
      </nav>
    </template>
    <div class="main-frame">
      <div class="main-row">
        <aside v-if="hasToc" class="right-sidebar-container" aria-label="On this page">
          <div class="right-sidebar">
            <div class="right-sidebar-panel">
              <div class="toc-container">
                <nav class="toc" aria-labelledby="on-this-page">
                  <h2 id="on-this-page">On this page</h2>
                  <TocList :headers="headers" :active="active" overview />
                </nav>
              </div>
            </div>
          </div>
        </aside>
        <div class="main-pane">
          <MobileToc v-if="hasToc" :headers="headers" :active="active" />
          <main>
            <div class="content-panel">
              <div class="container">
                <div v-if="notFound" class="hero">
                  <div class="copy">
                    <h1 id="_top">{{ title }}</h1>
                    <p class="tagline">Page not found. Check the URL or try using the search bar.</p>
                  </div>
                </div>
                <h1 v-else id="_top">{{ title }}</h1>
              </div>
            </div>
            <div v-if="!notFound" class="content-panel">
              <div class="container">
                <Content class="markdown-content" />
                <footer class="page-footer">
                  <PageActions :edit-url="editUrl" :issue-url="issueUrl" />
                  <Pagination v-if="previous || next" :previous="previous" :next="next" />
                </footer>
              </div>
            </div>
          </main>
        </div>
      </div>
    </div>
  </div>
</template>
