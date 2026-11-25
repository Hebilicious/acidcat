import type { Heading } from "vaporpress/client";

export interface TocEntry {
  readonly slug: string;
  readonly title: string;
  readonly children: readonly TocEntry[];
}

/** Nests each heading under the heading of a lower level above it. */
export const tocTree = (headings: readonly Heading[]): TocEntry[] => {
  const roots: { slug: string; title: string; level: number; children: TocEntry[] }[] = [];
  for (const heading of headings) {
    const parent = roots.at(-1);
    const entry = { slug: heading.slug, title: heading.title, level: heading.level, children: [] };
    if (parent !== undefined && heading.level > parent.level) parent.children.push(entry);
    else roots.push(entry);
  }
  return roots;
};
