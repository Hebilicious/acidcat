import type { HeadTag, PageData } from "vaporpress/client";
import { pageCard } from "../lib/social.ts";

const meta = (attrs: Record<string, string>): HeadTag => ({ tag: "meta", attrs });

/** The description, the canonical link, the Open Graph and Twitter cards, and the social image of a page. */
export const pageHead = (page: PageData): HeadTag[] => {
  const description = page.description ?? "";
  const card = pageCard({ path: page.path, title: page.title, description });
  return [meta({ name: "description", content: description }), { tag: "link", attrs: { rel: "canonical", href: card.url } }, ...card.meta.map(meta)];
};
