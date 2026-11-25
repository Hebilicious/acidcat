<script setup lang="ts">
import source from "../assets/mark.svg?raw";

const props = withDefaults(defineProps<{ idSuffix: string; size?: number }>(), { size: 36 });
const svg = source
  .replaceAll("acidcat-brass", `acidcat-brass-${props.idSuffix}`)
  .replace(/^<svg xmlns="http:\/\/www\.w3\.org\/2000\/svg" /, "<svg ")
  .replace(' width="64" height="64">', ` width="${props.size}" height="${props.size}" class="mark" aria-hidden="true">`);
</script>

<template>
  <span class="mark-frame" v-html="svg" />
</template>

<style scoped>
.mark-frame {
  display: inline-flex;
}
</style>
