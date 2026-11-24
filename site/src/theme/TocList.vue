<script setup lang="ts">
import type { Header } from "vitepress";

defineProps<{ headers: readonly Header[]; active: string; mobile?: boolean; overview?: boolean }>();
</script>

<template>
  <ul :class="{ isMobile: mobile }">
    <li v-if="overview">
      <a href="#_top" :aria-current="active === '_top' ? 'true' : 'false'"><span>Overview</span></a>
    </li>
    <li v-for="header in headers" :key="header.slug">
      <a :href="`#${header.slug}`" :aria-current="active === header.slug ? 'true' : 'false'"><span>{{ header.title }}</span></a>
      <TocList v-if="header.children.length > 0" :headers="header.children" :active="active" :mobile="mobile" />
    </li>
  </ul>
</template>
