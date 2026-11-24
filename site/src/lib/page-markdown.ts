import type { Element, ElementContent, Nodes, Root } from "hast";
import { fromHtml } from "hast-util-from-html";
import { toMdast } from "hast-util-to-mdast";
import { gfmToMarkdown } from "mdast-util-gfm";
import { toMarkdown } from "mdast-util-to-markdown";

export interface PageMarkdown {
  readonly title: string;
  readonly description: string;
  readonly markdown: string;
}

const dropped = new Set(["script", "style", "template", "svg", "canvas", "button", "noscript", "link", "meta"]);
const droppedClasses = ["copy", "sr-only", "tablist-wrapper", "header-anchor", "plate", "star-count"];

const classes = (node: Element): string[] => {
  const value = node.properties["className"];
  return Array.isArray(value) ? value.map(String) : [];
};

const isElement = (node: Nodes | ElementContent): node is Element => node.type === "element";

const textOf = (node: Nodes): string => {
  if (node.type === "text") return node.value;
  if (node.type === "element" || node.type === "root") return node.children.map(textOf).join("");
  return "";
};

const find = (node: Nodes, test: (element: Element) => boolean): Element | undefined => {
  if (isElement(node) && test(node)) return node;
  if (node.type !== "element" && node.type !== "root") return undefined;
  for (const child of node.children) {
    const found = find(child, test);
    if (found !== undefined) return found;
  }
  return undefined;
};

const findAll = (node: Nodes, test: (element: Element) => boolean, found: Element[] = []): Element[] => {
  if (isElement(node) && test(node)) found.push(node);
  if (node.type === "element" || node.type === "root") for (const child of node.children) findAll(child, test, found);
  return found;
};

const element = (tagName: string, children: ElementContent[]): Element => ({ type: "element", tagName, properties: {}, children });

/** The components of the docs write `data-role` in place of `role`, and the page sets the role in the browser. */
const roleOf = (node: Element): unknown => node.properties["role"] ?? node.properties["dataRole"];

const tabLabels = (root: Root): Map<string, string> =>
  new Map(findAll(root, (node) => roleOf(node) === "tab").map((tab) => [String(tab.properties["id"] ?? ""), textOf(tab).trim()]));

const isDropped = (node: Element): boolean =>
  dropped.has(node.tagName) || node.properties["ariaHidden"] === "true" || classes(node).some((name) => droppedClasses.includes(name));

const clean = (node: Element, labels: Map<string, string>, inCode = false): void => {
  const children: ElementContent[] = [];
  for (const child of node.children) {
    if (!isElement(child)) {
      if (child.type !== "comment") children.push(child);
      continue;
    }
    if (isDropped(child)) continue;
    clean(child, labels, inCode || child.tagName === "pre");
    if (roleOf(child) === "tabpanel") {
      const label = labels.get(String(child.properties["ariaLabelledBy"] ?? ""));
      delete child.properties["hidden"];
      if (label !== undefined) children.push(element("p", [element("strong", [{ type: "text", value: label }])]));
    }
    if (child.tagName === "figure" && classes(child).includes("frame")) {
      const title = textOf(find(child, (node) => classes(node).includes("title")) ?? element("span", [])).trim();
      child.children = child.children.filter((grandchild) => !(isElement(grandchild) && grandchild.tagName === "figcaption"));
      const language = child.properties["dataLanguage"];
      const code = find(child, (node) => node.tagName === "code");
      if (typeof language === "string" && language !== "" && code !== undefined) code.properties["className"] = [`language-${language}`];
      if (title !== "") children.push(element("p", [element("code", [{ type: "text", value: title }])]));
    }
    if (child.tagName === "aside") child.tagName = "blockquote";
    const previous = children.at(-1);
    if (child.tagName === "span" && previous !== undefined && isElement(previous) && previous.tagName === "span" && !inCode) {
      children.push({ type: "text", value: " " });
    }
    children.push(child);
  }
  node.children = children;
};

const metaContent = (root: Root, name: string): string => {
  const meta = find(root, (node) => node.tagName === "meta" && node.properties["name"] === name);
  return String(meta?.properties["content"] ?? "");
};

export const pageMarkdown = (html: string): PageMarkdown => {
  const root = fromHtml(html);
  const main = find(root, (node) => node.tagName === "main");
  if (main === undefined) throw new Error("The page has no <main>.");
  const heading = find(main, (node) => node.tagName === "h1");
  const title = heading === undefined ? "" : textOf(heading).trim();
  const description = metaContent(root, "description");
  const body = find(main, (node) => classes(node).includes("markdown-content")) ?? main;
  const labels = tabLabels(root);
  clean(body, labels);
  if (body === main && heading !== undefined) heading.tagName = "p";
  const content = toMarkdown(toMdast(element("div", body.children)), { extensions: [gfmToMarkdown()], bullet: "-", rule: "-" }).trim();
  const lead = description === "" ? "" : `> ${description}\n\n`;
  return { title, description, markdown: `# ${title}\n\n${lead}${content}\n` };
};
