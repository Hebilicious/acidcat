import type { HeadTag, PageData } from "vaporpress/client";
import { sectionOf, siteUrl, socialImage } from "../lib/social.ts";

const meta = (attrs: Record<string, string>): HeadTag => ({ tag: "meta", attrs });

/** The canonical link, the description, the Open Graph and Twitter cards, and the social image of a page. */
export const pageHead = (page: PageData): HeadTag[] => {
  const url = `${siteUrl}${page.path}`;
  const description = page.description ?? "";
  return [
    meta({ name: "description", content: description }),
    { tag: "link", attrs: { rel: "canonical", href: url } },
    meta({ property: "og:type", content: page.path === "/" ? "website" : "article" }),
    meta({ property: "og:site_name", content: "AcidCat" }),
    meta({ property: "og:url", content: url }),
    meta({ property: "og:title", content: page.title }),
    meta({ property: "og:description", content: description }),
    meta({ property: "og:locale", content: "en" }),
    meta({ name: "twitter:card", content: "summary_large_image" }),
    meta({ name: "twitter:title", content: page.title }),
    meta({ name: "twitter:description", content: description }),
    ...socialImage(sectionOf(page.path)).map(meta),
  ];
};
