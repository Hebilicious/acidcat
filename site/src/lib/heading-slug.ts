/** The slug of a heading, as GitHub writes it, so that the anchors of a page match its source on GitHub. */
export const headingSlug = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/<[^>]*>/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");
