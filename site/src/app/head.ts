import type { HeadTag, PageData } from "vaporpress/client";
import { pageCard, siteUrl } from "../lib/social.ts";

const meta = (attrs: Record<string, string>): HeadTag => ({ tag: "meta", attrs });

/**
 * The description, the canonical link, the Open Graph and Twitter cards, and the social image of a page. The cards are
 * for the crawlers of social sites, which read the HTML of the page, so the browser leaves them out of its script and of
 * the head after a page change.
 */
export const pageHead = (page: PageData): HeadTag[] => {
  const description = page.description ?? "";
  const cards = import.meta.env.SSR ? pageCard({ path: page.path, title: page.title, description }).meta : [];
  return [meta({ name: "description", content: description }), { tag: "link", attrs: { rel: "canonical", href: `${siteUrl}${page.path}` } }, ...cards.map(meta)];
};
