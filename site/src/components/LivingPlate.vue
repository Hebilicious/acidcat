<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import { plateImages } from "../lib/plate-images.ts";
import { mountPlate } from "../lib/living-plate.ts";

const alt = "A mechanical brass cat with glowing acid-green eyes sits on a brass pedestal in a dark workshop of the future, with holographic rings around it.";
const { phone, wide, fallback } = plateImages;

const root = ref<HTMLElement>();
const lifetime = new AbortController();
onMounted(() => {
  if (root.value !== undefined) mountPlate(root.value, lifetime.signal);
});
onUnmounted(() => lifetime.abort());
</script>

<template>
  <div ref="root" class="plate" data-plate>
    <picture>
      <source type="image/avif" :media="phone.media" :srcset="phone.srcset" :sizes="phone.sizes" data-phone />
      <source type="image/avif" :srcset="wide.srcset" :sizes="wide.sizes" />
      <img class="plate-still" :src="fallback.src" :srcset="fallback.srcset" :sizes="fallback.sizes" width="1672" height="941" :alt="alt" fetchpriority="high" />
    </picture>
    <canvas class="plate-canvas" aria-hidden="true"></canvas>
  </div>
</template>

<style scoped>
  .plate {
    --plate-position: 60% 50%;
    position: absolute;
    inset: 0;
    overflow: hidden;
    background: var(--palette-ink-950);
  }
  @media (max-width: 960px) {
    .plate {
      --plate-position: 50% 50%;
    }
  }
  .plate-still,
  .plate-canvas {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
  }
  .plate-still {
    object-fit: cover;
    object-position: var(--plate-position);
  }
  .plate-canvas {
    opacity: 0;
    transition: opacity 1.2s ease;
  }
  .plate.is-live .plate-canvas {
    opacity: 1;
  }
</style>
