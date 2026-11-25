/**
 * Calls `change` with the id of the last heading above a line `line` pixels under the top of the window, or
 * `undefined` when no heading is above it, each time that it changes. The root of the observer reaches far above the
 * window and ends at the line, so a heading intersects exactly when it is above the line, and the page reads no layout.
 * Returns a function that stops the observer.
 */
export const observeActiveHeading = (headings: readonly HTMLElement[], line: number, change: (id: string | undefined) => void): (() => void) => {
  const above = new Map<Element, boolean>();
  const observer = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) above.set(entry.target, entry.isIntersecting);
      change(headings.findLast((heading) => above.get(heading) === true)?.id);
    },
    { rootMargin: `100000px 0px ${Math.round(line - innerHeight)}px 0px` },
  );
  for (const heading of headings) observer.observe(heading);
  return () => observer.disconnect();
};
