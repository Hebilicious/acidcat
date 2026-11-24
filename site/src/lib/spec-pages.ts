import { readdir, readFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
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

const order = ["README.md", "catalog.md", "invocation.md", "events.md", "bindings/README.md", "bindings/programmatic.md", "bindings/typescript.md", "bindings/rust.md", "bindings/webmcp.md", "bindings/mcp.md", "bindings/cli.md", "bindings/http.md", "extensions/README.md", "extensions/attachments.md", "extensions/pagination.md", "conformance.md"];

const toPosix = (path: string): string => path.split(sep).join(posix.sep);

export const pageId = (file: string): string => {
  const withoutExtension = file.replace(/\.md$/, "");
  const id = withoutExtension === "README" ? "" : withoutExtension.replace(/\/README$/, "");
  return id === "" ? "spec" : `spec/${id}`;
};

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

export interface SpecSidebarLink {
  readonly label: string;
  readonly link: string;
}

export interface SpecSidebarGroup {
  readonly label: string;
  readonly items: SpecSidebarLink[];
}

export const specSidebar = async (repositoryRoot: string): Promise<(SpecSidebarLink | SpecSidebarGroup)[]> => {
  const pages = await readSpecPages(repositoryRoot);
  const groups = new Map<string, SpecSidebarLink[]>();
  const items: (SpecSidebarLink | SpecSidebarGroup)[] = [];
  for (const page of pages) {
    const parts = page.id.split("/");
    const link = { label: page.id === "spec" ? "Overview" : page.title, link: `/${page.id}/` };
    if (parts.length < 3) {
      if (parts.length === 2 && ["bindings", "extensions"].includes(parts[1] ?? "")) {
        const children: SpecSidebarLink[] = [{ label: "Overview", link: link.link }];
        groups.set(parts[1] ?? "", children);
        items.push({ label: page.title, items: children });
      } else {
        items.push(link);
      }
      continue;
    }
    groups.get(parts[1] ?? "")?.push(link);
  }
  return items;
};
