<script setup lang="ts" vapor>
import { useRoute } from "vue-router";
import Caret from "../theme/Caret.vue";
import { isGroup } from "../theme/site-theme.ts";
import type { Section } from "../theme/site-theme.ts";

defineProps<{ section: Section }>();
const route = useRoute();
</script>

<template>
  <a class="sidebar-section" :href="section.href">
    <span class="sidebar-section-title">{{ section.title }}</span>
    <span class="sidebar-section-note">{{ section.note }}</span>
  </a>
  <ul class="top-level">
    <li v-for="item in section.items" :key="item.text">
      <details v-if="isGroup(item)" open>
        <summary>
          <div class="group-label"><span class="large">{{ item.text }}</span></div>
          <Caret />
        </summary>
        <ul>
          <li v-for="link in item.items" :key="link.link">
            <a :href="link.link" :aria-current="route.path === link.link ? 'page' : undefined">{{ link.text }}</a>
          </li>
        </ul>
      </details>
      <a v-else :href="item.link" :aria-current="route.path === item.link ? 'page' : undefined">{{ item.text }}</a>
    </li>
  </ul>
</template>
