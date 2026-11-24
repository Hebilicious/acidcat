import type { AstroIntegration } from "astro";
import { createHash } from "node:crypto";
import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join, posix, relative, sep } from "node:path";
import { fileURLToPath } from "node:url";
import { gzipSync } from "node:zlib";
import { readPublishedPackages } from "../packages.ts";
import { pageMarkdown } from "../page-markdown.ts";
import { CONTENT_PATH } from "./content.ts";
import type { Page, SiteContent } from "./content.ts";

const sections = [
  { section: "home", prefix: "/", title: "Home" },
  { section: "docs", prefix: "/docs/", title: "Documentation" },
  { section: "spec", prefix: "/spec/", title: "Specification" },
  { section: "packages", prefix: "/packages/", title: "Packages" },
] as const;

const sectionOf = (path: string): Page["section"] => {
  const found = sections.findLast(({ prefix }) => path === prefix || (prefix !== "/" && path.startsWith(prefix)));
  if (found === undefined) throw new Error(`${path} belongs to no section of the site.`);
  return found.section;
};

const htmlPages = async (dist: string): Promise<string[]> => {
  const entries = await readdir(dist, { withFileTypes: true, recursive: true });
  return entries
    .filter((entry) => entry.isFile() && entry.name === "index.html")
    .map((entry) => `/${relative(dist, entry.parentPath).split(sep).join(posix.sep)}/`.replace(/^\/+/, "/"))
    .sort();
};

const readPages = async (dist: string, home: string): Promise<Page[]> =>
  Promise.all(
    (await htmlPages(dist)).map(async (path): Promise<Page> => {
      const converted = path === "/" ? homePage(home) : pageMarkdown(await readFile(join(dist, path, "index.html"), "utf8"));
      return { path, title: converted.title, description: converted.description, section: sectionOf(path), markdown: converted.markdown };
    }),
  );

const homePage = (markdown: string): { title: string; description: string; markdown: string } => ({
  title: /^# (.+)$/m.exec(markdown)?.[1] ?? "",
  description: /^> (.+)$/m.exec(markdown)?.[1] ?? "",
  markdown,
});

export const llmsText = (pages: readonly Page[], origin: string, home: string): string => {
  const summary = home.split("\n## ")[0]?.trim() ?? "";
  const links = sections
    .filter(({ section }) => section !== "home")
    .map(({ section, title }) => {
      const items = pages.filter((page) => page.section === section).map((page) => `- [${page.title}](${origin}${page.path}index.md): ${page.description}`);
      return `## ${title}\n\n${items.join("\n")}`;
    });
  const agents = [
    "## For agents",
    "",
    `- [MCP server](${origin}/mcp): the content of this site as MCP tools. Its Server Card is at ${origin}/mcp/server-card.`,
    `- [HTTP API](${origin}/api/capabilities): the same capabilities through the HTTP binding of AcidCat. The catalog is at ${origin}/api/catalog.`,
    `- [Agent skills](${origin}/.well-known/agent-skills/index.json): the skill that tells an agent how to build with AcidCat.`,
    "",
    "## Optional",
    "",
    `- [Full text](${origin}/llms-full.txt): every page of this site as Markdown, in one file.`,
  ];
  return `${[summary, ...links, agents.join("\n")].join("\n\n")}\n`;
};

const frontmatterDescription = (skill: string): string => {
  const lines = (/^---\n([\s\S]*?)\n---/.exec(skill)?.[1] ?? "").split("\n");
  const start = lines.findIndex((line) => line.startsWith("description:"));
  const inline = lines[start]?.slice("description:".length).trim() ?? "";
  if (inline !== "|" && inline !== ">") return inline;
  const block = lines.slice(start + 1);
  const end = block.findIndex((line) => !line.startsWith("  "));
  return (end === -1 ? block : block.slice(0, end)).map((line) => line.trim()).join(" ").trim();
};

const tarHeader = (name: string, size: number): Buffer => {
  const header = Buffer.alloc(512);
  const field = (value: string, offset: number, length: number): void => void header.write(value, offset, length, "ascii");
  const octal = (value: number, offset: number, length: number): void => field(`${value.toString(8).padStart(length - 1, "0")}\0`, offset, length);
  field(name, 0, 100);
  octal(0o644, 100, 8);
  octal(0, 108, 8);
  octal(0, 116, 8);
  octal(size, 124, 12);
  octal(0, 136, 12);
  field("        ", 148, 8);
  field("0", 156, 1);
  field("ustar\0", 257, 6);
  field("00", 263, 2);
  const checksum = header.reduce((total, byte) => total + byte, 0);
  field(`${checksum.toString(8).padStart(6, "0")}\0 `, 148, 8);
  return header;
};

/** A gzip-compressed tar of the files, as the archive type of the Agent Skills Discovery index wants: the files at its root. */
export const skillArchive = (files: readonly { readonly name: string; readonly data: Buffer }[]): Buffer => {
  const blocks = files.flatMap(({ name, data }) => [tarHeader(name, data.length), data, Buffer.alloc((512 - (data.length % 512)) % 512)]);
  return gzipSync(Buffer.concat([...blocks, Buffer.alloc(1024)]));
};

const skillFiles = async (directory: string): Promise<{ name: string; data: Buffer }[]> => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  const names = entries
    .filter((entry) => entry.isFile())
    .map((entry) => relative(directory, join(entry.parentPath, entry.name)).split(sep).join(posix.sep))
    .sort();
  return Promise.all(names.map(async (name) => ({ name, data: await readFile(join(directory, name)) })));
};

const writeSkills = async (dist: string, skillsRoot: string): Promise<void> => {
  const names = (await readdir(skillsRoot, { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name).sort();
  const skills = await Promise.all(
    names.map(async (name) => {
      const files = await skillFiles(join(skillsRoot, name));
      const skill = files.find((file) => file.name === "SKILL.md");
      if (skill === undefined) throw new Error(`The skill ${name} has no SKILL.md.`);
      const archive = skillArchive(files);
      const url = `/.well-known/agent-skills/${name}.tar.gz`;
      await writeOut(dist, url, archive);
      return {
        name,
        type: "archive",
        description: frontmatterDescription(skill.data.toString("utf8")),
        url,
        digest: `sha256:${createHash("sha256").update(archive).digest("hex")}`,
      };
    }),
  );
  await writeOut(dist, "/.well-known/agent-skills/index.json", `${JSON.stringify({ $schema: "https://schemas.agentskills.io/discovery/0.2.0/schema.json", skills }, null, 2)}\n`);
};

const writeOut = async (dist: string, path: string, data: string | Buffer): Promise<void> => {
  const file = join(dist, path);
  await mkdir(dirname(file), { recursive: true });
  await writeFile(file, data);
};

export const agentFiles = (repositoryRoot: string): AstroIntegration => {
  let origin = "";
  return {
    name: "acidcat-agent-files",
    hooks: {
      "astro:config:done": ({ config }) => {
        origin = (config.site ?? "").replace(/\/$/, "");
      },
      "astro:build:done": async ({ dir }) => {
        const dist = fileURLToPath(dir);
        const home = await readFile(new URL("home.md", import.meta.url), "utf8");
        const pages = await readPages(dist, home);
        const packages = (await readPublishedPackages(repositoryRoot)).map(({ name, registry, version, description, install, url }) => ({ name, registry, version, description, install, url }));
        const content: SiteContent = { pages, packages };
        await Promise.all([
          ...pages.map((page) => writeOut(dist, `${page.path}index.md`, page.markdown)),
          writeOut(dist, CONTENT_PATH, JSON.stringify(content)),
          writeOut(dist, "/llms.txt", llmsText(pages, origin, home)),
          writeOut(dist, "/llms-full.txt", pages.map((page) => page.markdown).join("\n\n---\n\n")),
          writeSkills(dist, join(repositoryRoot, "skills")),
        ]);
      },
    },
  };
};
