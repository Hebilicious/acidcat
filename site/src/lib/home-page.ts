const readStars = (body: unknown): number | undefined =>
  typeof body === "object" && body !== null && "stargazers_count" in body && typeof body.stargazers_count === "number" ? body.stargazers_count : undefined;

/** Asks GitHub for the number of stars of the repository, and shows it in the badge. The badge stays hidden when the request fails. */
export const showStarCount = (badge: HTMLElement, signal: AbortSignal): void => {
  fetch("https://api.github.com/repos/Hebilicious/acidcat", { headers: { Accept: "application/vnd.github+json" }, priority: "low", signal })
    .then((response) => (response.ok ? response.json() : undefined))
    .then((body: unknown) => {
      const stars = readStars(body);
      if (stars === undefined) return;
      badge.textContent = new Intl.NumberFormat("en", { notation: "compact" }).format(stars);
      badge.setAttribute("aria-label", `${stars} stars`);
      badge.hidden = false;
    })
    .catch(() => undefined);
};

/** Fades each section under `root` in when it comes into view. A section that another call already fades keeps its observer. */
export const revealSections = (root: HTMLElement, signal: AbortSignal): void => {
  const reveal = new IntersectionObserver(
    (entries) => {
      for (const entry of entries) {
        if (!entry.isIntersecting) continue;
        entry.target.classList.add("is-visible");
        reveal.unobserve(entry.target);
      }
    },
    { threshold: 0.15 },
  );
  for (const element of root.querySelectorAll(".section-head:not(.will-reveal), .surface:not(.will-reveal), .machine:not([drawable], .will-reveal), .blueprint:not(.will-reveal), .spec-sheet:not(.will-reveal)")) {
    element.classList.add("will-reveal");
    reveal.observe(element);
  }
  signal.addEventListener("abort", () => reveal.disconnect(), { once: true });
};
