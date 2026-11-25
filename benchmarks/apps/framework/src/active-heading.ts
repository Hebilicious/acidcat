import { onMounted, onUnmounted, ref } from "vue";
import type { Ref } from "vue";
import { observeActiveHeading } from "framework/behaviors";
import { onPageUpdated } from "framework/client";

/** The heading of the section that the reader is in: the last heading above a line near the top of the window. */
export const useActiveHeading = (): Ref<string> => {
  const active = ref("");
  let stop: (() => void) | undefined;
  const observe = (): void => {
    stop?.();
    stop = observeActiveHeading([...document.querySelectorAll<HTMLElement>("#content :is(h2, h3)[id]")], Math.round(innerHeight * 0.25), (id) => {
      active.value = id ?? "";
    });
  };
  onPageUpdated(observe);
  onMounted(() => addEventListener("resize", observe));
  onUnmounted(() => {
    stop?.();
    removeEventListener("resize", observe);
  });
  return active;
};
