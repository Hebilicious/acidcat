import type { Heading } from "vaporpress/client";
import type { PublishedPackage } from "./packages.ts";

export interface PackageGroup {
  readonly kind: PublishedPackage["kind"];
  readonly title: string;
  readonly text: string;
}

/** The groups of the packages page, in order. */
export const packageGroups: readonly PackageGroup[] = [
  { kind: "tool", title: "Tools", text: "Check and format catalogs, and test any implementation from outside." },
  { kind: "catalog", title: "Catalog libraries", text: "Write a catalog in the language of your choice. Every library writes the same canonical JSON." },
  { kind: "core", title: "Cores", text: "Run the capabilities and serve the surfaces. Each core passes acid-cat conform." },
  { kind: "library", title: "Libraries", text: "Shared pieces of the TypeScript reference implementation." },
];

/** The headings of the packages page, for its table of contents: one for each group that has a package. */
export const packageHeadings = (packages: readonly PublishedPackage[]): Heading[] =>
  packageGroups
    .filter((group) => packages.some((entry) => entry.kind === group.kind))
    .map((group) => ({ level: 2, title: group.title, slug: `group-${group.kind}` }));
