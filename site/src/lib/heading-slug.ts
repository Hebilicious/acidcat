import type { MarkdownOptions } from "vitepress";

/** The slug of a heading, as GitHub writes it, so that the anchors of a page match its source on GitHub. */
export const headingSlug = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");

type Permalink = NonNullable<Exclude<MarkdownOptions["anchor"], boolean | undefined>["permalink"]>;

/** Adds a link to each heading. Its label names the heading, and CSS draws its mark, so the text of the heading has no extra character. */
export const headingAnchor: Permalink = (slug, _options, state, index) => {
  const inline = state.tokens[index + 1];
  const title = (inline?.children ?? [])
    .filter((token) => token.type === "text" || token.type === "code_inline")
    .map((token) => token.content)
    .join("")
    .trim();
  const open = new state.Token("link_open", "a", 1);
  open.attrs = [
    ["class", "header-anchor"],
    ["href", `#${slug}`],
    ["aria-label", `Permalink to “${title}”`],
  ];
  inline?.children?.push(open, new state.Token("link_close", "a", -1));
};
