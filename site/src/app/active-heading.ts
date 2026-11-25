import { observeActiveHeading } from "vaporpress/behaviors";
import { onPageUpdated } from "vaporpress/client";
import { onMounted, onUnmounted, ref } from "vue";
import type { Ref } from "vue";

/** The heading of the section that the reader is in: the last heading above a line 2rem under the header. */
export const useActiveHeading = (): Ref<string> => {
  const active = ref("_top");
  let stop: (() => void) | undefined;
  const line = () => parseFloat(getComputedStyle(document.documentElement).fontSize) * (matchMedia("(min-width: 72rem)").matches ? 6 : 9);
  const observe = () => {
    stop?.();
    const headings = [...document.querySelectorAll<HTMLElement>("#_top, .markdown-content :is(h2, h3)[id]")];
    stop = observeActiveHeading(headings, line(), (id) => {
      active.value = id ?? "_top";
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
