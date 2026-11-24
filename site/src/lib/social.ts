export const siteUrl = "https://acidcat.hebilicious.workers.dev";

export type Section = "home" | "docs" | "examples" | "spec" | "packages";

const alt: Record<Section, string> = {
  home: "AcidCat: a mechanical brass cat on a pedestal, with the words Application Capability Identification Catalog.",
  docs: "AcidCat documentation: quick start, concepts and guides.",
  examples: "AcidCat examples: an air conditioner on every core and every surface.",
  spec: "AcidCat specification 0.1.",
  packages: "AcidCat packages on npm, crates.io, PyPI, Go and Pkl.",
};

export const sectionOf = (path: string): Section => {
  if (path.startsWith("/docs/")) return "docs";
  if (path.startsWith("/examples/")) return "examples";
  if (path.startsWith("/spec/")) return "spec";
  if (path.startsWith("/packages/")) return "packages";
  return "home";
};

export const socialImage = (section: Section): Record<string, string>[] => {
  const image = `${siteUrl}/og/${section}.jpg`;
  return [
    { property: "og:image", content: image },
    { property: "og:image:type", content: "image/jpeg" },
    { property: "og:image:width", content: "1200" },
    { property: "og:image:height", content: "630" },
    { property: "og:image:alt", content: alt[section] },
    { name: "twitter:image", content: image },
    { name: "twitter:image:alt", content: alt[section] },
  ];
};

export interface CardPage {
  readonly path: string;
  readonly title: string;
  readonly description: string;
}

export const pageCard = (page: CardPage): { readonly url: string; readonly meta: Record<string, string>[] } => {
  const url = `${siteUrl}${page.path}`;
  return {
    url,
    meta: [
      { property: "og:type", content: page.path === "/" ? "website" : "article" },
      { property: "og:site_name", content: "AcidCat" },
      { property: "og:url", content: url },
      { property: "og:title", content: page.title },
      { property: "og:description", content: page.description },
      { property: "og:locale", content: "en" },
      { name: "twitter:card", content: "summary_large_image" },
      { name: "twitter:title", content: page.title },
      { name: "twitter:description", content: page.description },
      ...socialImage(sectionOf(page.path)),
    ],
  };
};
