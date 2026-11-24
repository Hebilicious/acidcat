<script setup lang="ts" vapor>
import Counter from "../src/Counter.vue";
import { data } from "../src/numbers.data.ts";

defineOptions({ __page: { title: "Home", description: "The homepage of the fixture.", frontmatter: {}, headings: [] } });
</script>

<template>
  <h1 class="home-title">A unique homepage</h1>
  <p class="home-static">This paragraph is static HTML that the lean chunk leaves out.</p>
  <p class="numbers">{{ data.numbers.join(", ") }} {{ data.built }}</p>
  <Counter :start="1" />
  <p><a class="to-guide" href="/guide/">Read the guide</a></p>
</template>
