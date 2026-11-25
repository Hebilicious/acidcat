import type { HeadTag, PageData } from "vaporpress/client";
import { pageCard, siteUrl } from "../lib/social.ts";

const meta = (attrs: Record<string, string>): HeadTag => ({ tag: "meta", attrs });

/** The crawlers of social sites read the cards from the HTML of the page, not from its script. */
export const pageHead = (page: PageData): HeadTag[] => {
  const description = page.description ?? "";
  const cards = import.meta.env.SSR ? pageCard({ path: page.path, title: page.title, description }).meta : [];
  return [meta({ name: "description", content: description }), { tag: "link", attrs: { rel: "canonical", href: `${siteUrl}${page.path}` } }, ...cards.map(meta)];
};
