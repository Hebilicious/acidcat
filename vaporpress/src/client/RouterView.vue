<script setup lang="ts" vapor>
import { computed, nextTick, onMounted, watch } from "vue";
import { useRoute } from "vue-router";
import { pageUpdated } from "./page-updated.ts";

const route = useRoute();
const page = computed(() => route.matched.at(-1)?.components?.["default"]);
onMounted(pageUpdated);
watch(page, () => void nextTick(pageUpdated), { flush: "post" });
</script>

<template><component :is="page" /></template>
