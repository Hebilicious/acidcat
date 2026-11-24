<script setup lang="ts" vapor>
import { ref } from "vue";

const props = defineProps<{ readonly start?: number }>();
const count = ref(props.start ?? 0);
</script>

<template>
  <button type="button" class="counter" @click="count++">Count {{ count }}</button>
  <div class="counter-slot"><slot /></div>
</template>
