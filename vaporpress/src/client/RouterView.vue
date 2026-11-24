<script setup lang="ts" vapor>
import { computed } from "vue";
import { useRoute } from "vue-router";

const route = useRoute();
const page = computed(() => route.matched.at(-1)?.components?.["default"]);
</script>

<template><component :is="page" /></template>
