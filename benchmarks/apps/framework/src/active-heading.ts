import { onMounted, onUnmounted, ref } from "vue";
import type { Ref } from "vue";
import { onPageUpdated } from "framework/client";

/**
 * The heading of the section that the reader is in: the last heading above a line near the top of the window. The root
 * of the observer reaches far above the window and ends at that line, so a heading intersects when it is above the line.
 */
export const useActiveHeading = (): Ref<string> => {
  const active = ref("");
  let observer: IntersectionObserver | undefined;
  const observe = (): void => {
    observer?.disconnect();
    const headings = [...document.querySelectorAll<HTMLElement>("#content :is(h2, h3)[id]")];
    const above = new Map<Element, boolean>();
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) above.set(entry.target, entry.isIntersecting);
        active.value = headings.findLast((heading) => above.get(heading) === true)?.id ?? "";
      },
      { rootMargin: `100000px 0px -${Math.round(innerHeight * 0.75)}px 0px` },
    );
    for (const heading of headings) observer.observe(heading);
  };
  onPageUpdated(observe);
  onMounted(() => addEventListener("resize", observe));
  onUnmounted(() => {
    observer?.disconnect();
    removeEventListener("resize", observe);
  });
  return active;
};
