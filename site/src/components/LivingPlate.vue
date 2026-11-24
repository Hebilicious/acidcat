<script setup lang="ts">
import { onMounted, onUnmounted, ref } from "vue";
import phone840 from "../assets/hero/phone-840.avif?url";
import phone from "../assets/hero/phone.avif?url";
import phone2x from "../assets/hero/phone@2x.avif?url";
import plateAvif from "../assets/hero/plate.avif?url";
import plate2xAvif from "../assets/hero/plate@2x.avif?url";
import plateWebp from "../assets/hero/plate.webp?url";
import plate2xWebp from "../assets/hero/plate@2x.webp?url";
import { art, phoneCrop, phoneMedia } from "../lib/plate-crop.ts";
import { mountPlate } from "../lib/living-plate.ts";

const alt = "A mechanical brass cat with glowing acid-green eyes sits on a brass pedestal in a dark workshop of the future, with holographic rings around it.";
const phoneWidth = (scale: number) => Math.round(phoneCrop.width * scale);
// At 960px and below the hero is 1.02 times as tall as it is wide, and the plate covers it by its height.
const phoneSizes = `${Math.ceil(102 * (phoneCrop.width / art.height))}vw`;
const phoneSrcset = `${phone840} 840w, ${phone} ${phoneWidth(1)}w, ${phone2x} ${phoneWidth(2)}w`;

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
      <source type="image/avif" :media="phoneMedia" :srcset="phoneSrcset" :sizes="phoneSizes" data-phone />
      <source type="image/avif" :srcset="`${plateAvif} 1672w, ${plate2xAvif} 3344w`" sizes="100vw" />
      <img class="plate-still" :src="plateWebp" :srcset="`${plateWebp} 1672w, ${plate2xWebp} 3344w`" sizes="100vw" width="1672" height="941" :alt="alt" fetchpriority="high" />
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
