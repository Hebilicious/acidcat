export const siteUrl = "https://acidcat.hebilicious.workers.dev";

export type Section = "home" | "docs" | "spec" | "packages";

const alt: Record<Section, string> = {
  home: "AcidCat: a mechanical brass cat on a pedestal, with the words Application Capability Identification Catalog.",
  docs: "AcidCat documentation: quick start, concepts and guides.",
  spec: "AcidCat specification 0.1.",
  packages: "AcidCat packages on npm, crates.io, PyPI, Go and Pkl.",
};

export const sectionOf = (path: string): Section => {
  if (path.startsWith("/docs/")) return "docs";
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
