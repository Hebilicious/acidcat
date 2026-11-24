import { onContentUpdated } from "vitepress";
import { onMounted, onUnmounted, ref } from "vue";
import type { Ref } from "vue";

/**
 * The heading of the section that the reader is in: the last heading above a line 2rem under the header.
 * The root of the IntersectionObserver reaches far above the viewport and ends at the line, so a heading intersects
 * exactly when it is above the line, and each crossing reports a change. The page reads no layout.
 */
export const useActiveHeading = (): Ref<string> => {
  const active = ref("_top");
  let observer: IntersectionObserver | undefined;

  const observe = () => {
    observer?.disconnect();
    const headings = [...document.querySelectorAll<HTMLElement>("#_top, .markdown-content :is(h2, h3)[id]")];
    const above = new Map<Element, boolean>();
    observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) above.set(entry.target, entry.isIntersecting);
        active.value = headings.findLast((heading) => above.get(heading) === true)?.id ?? "_top";
      },
      { rootMargin: `100000px 0px ${Math.round(line() - innerHeight)}px 0px` },
    );
    for (const heading of headings) observer.observe(heading);
  };

  const line = () => parseFloat(getComputedStyle(document.documentElement).fontSize) * (matchMedia("(min-width: 72rem)").matches ? 6 : 9);
  onContentUpdated(observe);
  onMounted(() => addEventListener("resize", observe));
  onUnmounted(() => {
    observer?.disconnect();
    removeEventListener("resize", observe);
  });
  return active;
};
