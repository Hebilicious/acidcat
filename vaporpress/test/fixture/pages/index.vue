<script setup lang="ts" vapor>
import Counter from "../src/Counter.vue";
import { data } from "../src/numbers.data.ts";
import diagram from "./guide/diagram.png?image";

defineOptions({ __page: { title: "Home", description: "The homepage of the fixture.", frontmatter: {}, headings: [] } });
</script>

<template>
  <h1 class="home-title">A unique homepage</h1>
  <p class="home-static">This paragraph is static HTML that the lean chunk leaves out.</p>
  <p class="numbers">{{ data.numbers.join(", ") }} {{ data.built }}</p>
  <img class="home-diagram" v-bind="diagram" alt="A blue diagram" />
  <Counter :start="1" />
  <p><a class="to-guide" href="/guide/">Read the guide</a></p>
</template>
