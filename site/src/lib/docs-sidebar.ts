import { readdir, readFile } from "node:fs/promises";
import { join } from "node:path";
import type { SidebarItem, SidebarLink } from "../theme/site-theme.ts";

interface DocsPage {
  readonly link: string;
  readonly label: string;
  readonly order: number;
}

const field = (frontmatter: string, pattern: RegExp): string | undefined => pattern.exec(frontmatter)?.[1]?.trim();

const readPage = async (directory: string, file: string, prefix: string): Promise<DocsPage> => {
  const source = await readFile(join(directory, file), "utf8");
  const frontmatter = /^---\n([\s\S]*?)\n---/.exec(source)?.[1] ?? "";
  const title = field(frontmatter, /^title:\s*(.+)$/m);
  if (title === undefined) throw new Error(`${join(directory, file)} has no title in its frontmatter.`);
  const name = file.replace(/\.md$/, "");
  return {
    link: name === "index" ? prefix : `${prefix}${name}/`,
    label: field(frontmatter, /^\s+label:\s*(.+)$/m) ?? title,
    order: Number(field(frontmatter, /^\s+order:\s*(\d+)$/m) ?? Number.MAX_SAFE_INTEGER),
  };
};

const directoryLinks = async (content: string, directory: string): Promise<SidebarLink[]> => {
  const files = (await readdir(join(content, directory))).filter((file) => file.endsWith(".md"));
  const pages = await Promise.all(files.map((file) => readPage(join(content, directory), file, `/${directory}/`)));
  return pages.sort((a, b) => a.order - b.order || a.label.localeCompare(b.label)).map(({ label, link }) => ({ text: label, link }));
};

const pageLink = async (content: string, file: string, link: string): Promise<SidebarLink> => {
  const page = await readPage(content, file, "/");
  return { text: page.label, link };
};

/** The sidebar of the docs: the introduction, the quick start, and one group for each directory of the docs. */
export const docsSidebar = async (content: string): Promise<SidebarItem[]> => [
  await pageLink(content, "docs/index.md", "/docs/"),
  await pageLink(content, "docs/quick-start.md", "/docs/quick-start/"),
  { text: "Concepts", items: await directoryLinks(content, "docs/concepts") },
  { text: "Guides", items: await directoryLinks(content, "docs/guides") },
  { text: "Reference", items: await directoryLinks(content, "docs/reference") },
];

export const examplesSidebar = (content: string): Promise<SidebarItem[]> => directoryLinks(content, "examples");
