<script setup lang="ts">
import type { SidebarLink } from "./sidebar.ts";

defineProps<{ previous: SidebarLink | undefined; next: SidebarLink | undefined }>();
</script>

<template>
  <div class="pagination-links" dir="ltr">
    <a v-if="previous" :href="previous.link" rel="prev">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17 11H9.41l3.3-3.29a1.004 1.004 0 1 0-1.42-1.42l-5 5a1 1 0 0 0-.21.33 1 1 0 0 0 0 .76 1 1 0 0 0 .21.33l5 5a1.002 1.002 0 0 0 1.639-.325 1 1 0 0 0-.219-1.095L9.41 13H17a1 1 0 0 0 0-2Z" /></svg>
      <span>Previous<br /><span class="link-title">{{ previous.text }}</span></span>
    </a>
    <a v-if="next" :href="next.link" rel="next">
      <svg aria-hidden="true" width="16" height="16" viewBox="0 0 24 24" fill="currentColor"><path d="M17.92 11.62a1.001 1.001 0 0 0-.21-.33l-5-5a1.003 1.003 0 1 0-1.42 1.42l3.3 3.29H7a1 1 0 0 0 0 2h7.59l-3.3 3.29a1.002 1.002 0 0 0 .325 1.639 1 1 0 0 0 1.095-.219l5-5a1 1 0 0 0 .21-.33 1 1 0 0 0 0-.76Z" /></svg>
      <span>Next<br /><span class="link-title">{{ next.text }}</span></span>
    </a>
  </div>
</template>
