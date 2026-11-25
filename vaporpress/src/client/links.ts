import { nextTick } from "vue";
import type { Router } from "vue-router";
import { notFoundRoute } from "./router.ts";

/** The path, query and hash of a link to a page of the site, or `undefined` when the browser must follow the link itself. */
export const pageHref = (router: Router, anchor: HTMLAnchorElement): string | undefined => {
  if (anchor.target !== "" && anchor.target !== "_self") return undefined;
  if (anchor.hasAttribute("download") || anchor.getAttribute("href") === null) return undefined;
  const url = new URL(anchor.href, location.href);
  if (url.origin !== location.origin) return undefined;
  const resolved = router.resolve(url.pathname);
  if (resolved.matched.length === 0 || resolved.name === notFoundRoute) return undefined;
  return `${url.pathname}${url.search}${url.hash}`;
};

const anchorOf = (target: EventTarget | null): HTMLAnchorElement | undefined => {
  const element = target instanceof Element ? target.closest("a") : null;
  return element instanceof HTMLAnchorElement ? element : undefined;
};

const focusable = "a[href], area[href], button, input, select, textarea, iframe, summary, [tabindex], [contenteditable]";

/** As the browser does when it follows a link in the page, so that the next Tab goes on from the target. */
const focusHash = (hash: string): void => {
  const target = hash === "" ? null : document.getElementById(decodeURIComponent(hash.slice(1)));
  if (target === null) return;
  if (!target.matches(focusable)) {
    target.setAttribute("tabindex", "-1");
    target.addEventListener("blur", () => target.removeAttribute("tabindex"), { once: true });
  }
  target.focus({ preventScroll: true });
};

/** Changes the page in the browser when the reader clicks a link to another page of the site, so a plain `<a href>` in Markdown needs no component. */
export const interceptLinks = (router: Router): void => {
  document.addEventListener("click", (event) => {
    if (event.defaultPrevented || event.button !== 0 || event.metaKey || event.ctrlKey || event.shiftKey || event.altKey) return;
    const anchor = anchorOf(event.target);
    if (anchor === undefined) return;
    const href = pageHref(router, anchor);
    if (href === undefined) return;
    event.preventDefault();
    const url = new URL(href, location.href);
    const samePage = url.pathname === location.pathname && url.search === location.search;
    if (samePage && url.hash === location.hash) {
      document.getElementById(decodeURIComponent(url.hash.slice(1)))?.scrollIntoView();
      focusHash(url.hash);
      return;
    }
    void router.push(href).then(
      async () => {
        await nextTick();
        focusHash(url.hash);
      },
      () => undefined,
    );
  });
};

export { anchorOf };
