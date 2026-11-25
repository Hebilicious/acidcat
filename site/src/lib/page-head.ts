import type { HeadConfig, PageData } from "vitepress";
import { pageCard } from "./social.ts";

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

/** The path of a page on the site, from the file that VitePress writes for it. */
export const pagePath = (relativePath: string): string => `/${relativePath.replace(/(^|\/)index\.md$/, "$1")}`;

/** Gives a page of the specification the title, the description and the source of its parameters. */
export const applyRouteParams = (pageData: PageData): void => {
  const params = pageData.params ?? {};
  const title = text(params["title"]);
  if (title !== undefined) {
    pageData.title = title;
    pageData.frontmatter["title"] = title;
  }
  const description = text(params["description"]);
  if (description !== undefined) {
    pageData.description = description;
    pageData.frontmatter["description"] = description;
  }
  const source = text(params["source"]);
  if (source !== undefined) pageData.frontmatter["source"] = source;
};

/** The canonical link, the Open Graph and Twitter cards, and the social image of a page. */
export const pageHead = (pageData: PageData): HeadConfig[] => {
  const card = pageCard({
    path: pagePath(pageData.relativePath),
    title: text(pageData.frontmatter["title"]) ?? pageData.title,
    description: text(pageData.frontmatter["description"]) ?? pageData.description,
  });
  return [["link", { rel: "canonical", href: card.url }], ...card.meta.map((attrs): HeadConfig => ["meta", attrs])];
};
