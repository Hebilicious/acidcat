export interface Heading {
  readonly level: number;
  readonly slug: string;
  readonly title: string;
}

/** What the layout of a site knows about the page on screen. A Markdown page gets it from its frontmatter and its headings. */
export interface PageData {
  readonly path: string;
  readonly title: string;
  readonly description?: string;
  readonly frontmatter: Readonly<Record<string, unknown>>;
  readonly headings: readonly Heading[];
  /** The source file of a Markdown page, relative to the root of the site. */
  readonly file?: string;
}

export interface HeadTag {
  readonly tag: "meta" | "link" | "script" | "style";
  readonly attrs: Readonly<Record<string, string>>;
  readonly children?: string;
}
