const pageTitleId = "_top";

const onIdle = (callback: () => void) => {
  if ("requestIdleCallback" in window) window.requestIdleCallback(callback);
  else setTimeout(callback, 1);
};

/**
 * The table of contents of a docs page: it marks the link of the heading at the top of the viewport. It takes the
 * place of the `starlight-toc` element of Starlight, with the same markup and behavior, and it reads the sizes of the
 * header and of the viewport only in a `ResizeObserver` callback, where the layout is already done.
 */
export class StarlightTOC extends HTMLElement {
  private currentLink = this.querySelector<HTMLAnchorElement>('a[aria-current="true"]');
  private readonly minLevel = Number.parseInt(this.dataset["minH"] ?? "2", 10);
  private readonly maxLevel = Number.parseInt(this.dataset["maxH"] ?? "3", 10);
  private readonly headingSelector = `h1#${pageTitleId},:where(${Array.from({ length: 1 + this.maxLevel - this.minLevel }, (_, index) => `h${this.minLevel + index}`).join()})[id]`;

  set current(link: HTMLAnchorElement) {
    if (link === this.currentLink) return;
    this.currentLink?.removeAttribute("aria-current");
    link.setAttribute("aria-current", "true");
    this.currentLink = link;
  }

  constructor() {
    super();
    onIdle(() => this.init());
  }

  private headingOf(start: Element): Element | null {
    let element: Element | null = start;
    while (element !== null) {
      if (element.matches(".sl-markdown-content, main > *")) return document.getElementById(pageTitleId);
      if (element.matches(this.headingSelector)) return element;
      const childHeading = element.querySelector(this.headingSelector);
      if (childHeading !== null) return childHeading;
      let previous: Element | null = element.previousElementSibling;
      while (previous?.lastElementChild) previous = previous.lastElementChild;
      element = previous ?? element.parentElement;
    }
    return null;
  }

  private init() {
    const links = [...this.querySelectorAll("a")];
    const selector = this.headingSelector;
    const targets = document.querySelectorAll(
      [
        `main :where(${selector})`,
        `main :where(${selector}, .sl-heading-wrapper) ~ *:not(:has(${selector}))`,
        `main .sl-markdown-content > *:not(:has(${selector}))`,
        `main > *:not(:has(${selector}))`,
      ].join(),
    );
    const setCurrent = (entries: IntersectionObserverEntry[]) => {
      for (const { isIntersecting, target } of entries) {
        if (!isIntersecting) continue;
        const heading = this.headingOf(target);
        const link = heading === null ? undefined : links.find((candidate) => candidate.hash === `#${encodeURIComponent(heading.id)}`);
        if (link !== undefined) {
          this.current = link;
          break;
        }
      }
    };

    const header = document.querySelector("header");
    const summary = this.querySelector("summary");
    let observer: IntersectionObserver | undefined;
    const sizes = new ResizeObserver(() => {
      observer?.disconnect();
      const top = (header?.getBoundingClientRect().height ?? 0) + (summary?.getBoundingClientRect().height ?? 0) + 32;
      observer = new IntersectionObserver(setCurrent, { rootMargin: `-${top}px 0% ${top + 53 - document.documentElement.clientHeight}px` });
      for (const target of targets) observer.observe(target);
    });
    // A new observation calls back after the next layout, also when only the height of the viewport changes.
    const measure = () => {
      sizes.disconnect();
      sizes.observe(document.documentElement);
    };
    measure();
    window.addEventListener("resize", measure);
  }
}

customElements.define("starlight-toc", StarlightTOC);
