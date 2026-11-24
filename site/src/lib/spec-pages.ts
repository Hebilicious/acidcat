import { readdir, readFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import type { SidebarItem, SidebarLink } from "../theme/site-theme.ts";
import { replaceDiagrams } from "./spec-diagrams.ts";

export const repositoryUrl = "https://github.com/Hebilicious/acidcat";

export interface SpecPage {
  readonly id: string;
  readonly source: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
  readonly order: number;
}

const order = ["README.md", "catalog.md", "invocation.md", "events.md", "surfaces/README.md", "surfaces/programmatic.md", "surfaces/typescript.md", "surfaces/rust.md", "surfaces/webmcp.md", "surfaces/mcp.md", "surfaces/cli.md", "surfaces/http.md", "extensions/README.md", "extensions/attachments.md", "extensions/pagination.md", "conformance.md"];

const toPosix = (path: string): string => path.split(sep).join(posix.sep);

export const pageId = (file: string): string => {
  const withoutExtension = file.replace(/\.md$/, "");
  const id = withoutExtension === "README" ? "" : withoutExtension.replace(/\/README$/, "");
  return id === "" ? "spec" : `spec/${id}`;
};

/** The parameter of the dynamic route of a page: its path under /spec/, which ends with index so that its URL ends with a slash. */
export const specRoute = (id: string): string => (id === "spec" ? "index" : `${id.slice("spec/".length)}/index`);

const markdownFiles = async (root: string, directory = root): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true });
  const nested = await Promise.all(
    entries.map((entry) => {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) return markdownFiles(root, path);
      return Promise.resolve(entry.name.endsWith(".md") ? [toPosix(relative(root, path))] : []);
    }),
  );
  return nested.flat();
};

export const rewriteLink = (target: string, file: string, specRoot: string): string => {
  if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("#") || target.startsWith("/")) return target;
  const [path = "", anchor] = target.split("#", 2);
  const hash = anchor === undefined ? "" : `#${anchor}`;
  const resolved = posix.normalize(posix.join(posix.dirname(file), path));
  if (!resolved.startsWith("../") && resolved.endsWith(".md")) return `/${pageId(resolved)}/${hash}`;
  const fromRepository = posix.normalize(posix.join(specRoot, resolved));
  const kind = /\.[a-z0-9]+$/i.test(fromRepository) ? "blob" : "tree";
  return `${repositoryUrl}/${kind}/main/${fromRepository}${hash}`;
};

const rewriteLinks = (markdown: string, file: string, specRoot: string): string => {
  let fenced = false;
  return markdown
    .split("\n")
    .map((line) => {
      if (/^\s*(```|~~~)/.test(line)) fenced = !fenced;
      if (fenced) return line;
      return line.replace(/\]\(([^)\s]+)\)/g, (_match, target: string) => `](${rewriteLink(target, file, specRoot)})`);
    })
    .join("\n");
};

const firstParagraph = (markdown: string): string => {
  const paragraph = markdown
    .split(/\n\s*\n/)
    .map((block) => block.trim())
    .find((block) => block !== "" && !/^[#|`>-]/.test(block) && !block.startsWith("```"));
  const text = (paragraph ?? "").replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/[*`]/g, "").replace(/\s+/g, " ");
  const sentence = /^.*?\.(\s|$)/.exec(text)?.[0] ?? text;
  return sentence.trim();
};

export const readSpecPages = async (repositoryRoot: string): Promise<SpecPage[]> => {
  const specDirectory = join(repositoryRoot, "spec");
  const specRoot = toPosix(relative(repositoryRoot, specDirectory));
  const files = await markdownFiles(specDirectory);
  const pages = await Promise.all(
    files.map(async (file) => {
      const text = await readFile(join(specDirectory, file), "utf8");
      const heading = /^#\s+(.+)$/m.exec(text);
      const title = heading?.[1]?.trim() ?? posix.basename(dirname(file));
      const body = replaceDiagrams(rewriteLinks(heading === null ? text : text.replace(heading[0], "").trimStart(), file, specRoot));
      const position = order.indexOf(file);
      return {
        id: pageId(file),
        source: `${specRoot}/${file}`,
        title,
        description: firstParagraph(body),
        body,
        order: position === -1 ? order.length : position,
      };
    }),
  );
  return pages.sort((a, b) => a.order - b.order || a.id.localeCompare(b.id));
};

/** The sidebar of the specification, in the order of the pages: a group for each directory with an overview. */
export const specSidebar = (pages: readonly SpecPage[]): SidebarItem[] => {
  const groups = new Map<string, SidebarLink[]>();
  const items: SidebarItem[] = [];
  for (const page of pages) {
    const parts = page.id.split("/");
    const link = { text: page.id === "spec" ? "Overview" : page.title, link: `/${page.id}/` };
    const directory = parts[1] ?? "";
    if (parts.length === 2 && ["surfaces", "extensions"].includes(directory)) {
      const children: SidebarLink[] = [{ text: "Overview", link: link.link }];
      groups.set(directory, children);
      items.push({ text: page.title, items: children });
    } else if (parts.length < 3) {
      items.push(link);
    } else {
      groups.get(directory)?.push(link);
    }
  }
  return items;
};
