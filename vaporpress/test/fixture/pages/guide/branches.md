---
title: Branches
---

<script setup>
import { ref } from "vue";

const show = ref(false);
const items = ref([1]);
</script>

# Branches

<div class="controls"><button type="button" class="toggle" v-on:click="show = !show">Toggle</button> <button type="button" class="grow" v-on:click="items.push(items.length + 1)">Grow</button></div>

<section v-if="show" class="when-true"><p>Shown after a click.</p><p>Static text.</p></section>
<section v-else class="when-false"><p>Shown at first.</p><p>Static text.</p></section>

<ul class="items"><li v-for="item in items" :key="item"><p>An item.</p><p>Static text.</p></li></ul>
