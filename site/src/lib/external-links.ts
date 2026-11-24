const site = "https://acidcat.hebilicious.workers.dev";

export const isExternal = (href: unknown): boolean => typeof href === "string" && /^https?:\/\//i.test(href) && !href.startsWith(site);
