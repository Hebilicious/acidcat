import { readFile } from "node:fs/promises";
import { parse } from "yaml";

/** A page of the fixture: its id is its file path without `.md`, for example `guide/installation`. */
export interface FixturePage {
  readonly id: string;
  readonly title: string;
  readonly description: string;
  readonly body: string;
}

export interface SidebarGroup {
  readonly label: string;
  readonly items: readonly string[];
}

export const sidebar: readonly SidebarGroup[] = [
  { label: "Guide", items: ["guide/index", "guide/installation", "guide/configuration", "guide/routing", "guide/deployment"] },
  { label: "Reference", items: ["reference/index", "reference/api", "reference/cli", "reference/faq"] },
];

export const pageIds: readonly string[] = ["index", ...sidebar.flatMap((group) => group.items)];

export const fixtureDir = new URL("../fixture/", import.meta.url);

const frontmatterPattern = /^---\n([\s\S]*?)\n---\n/;

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const parsePage = (id: string, source: string): FixturePage => {
  const match = frontmatterPattern.exec(source);
  const data: unknown = match === null ? undefined : parse(match[1] ?? "");
  if (match === null || !isRecord(data) || typeof data["title"] !== "string" || typeof data["description"] !== "string") {
    throw new Error(`fixture/${id}.md needs a frontmatter with a title and a description.`);
  }
  return { id, title: data["title"], description: data["description"], body: source.slice(match[0].length).trim() };
};

export const readFixture = async (): Promise<readonly FixturePage[]> =>
  Promise.all(pageIds.map(async (id) => parsePage(id, await readFile(new URL(`${id}.md`, fixtureDir), "utf8"))));

export interface Tab {
  readonly label: string;
  readonly code: string;
}

const tabsPattern = /^:::tabs\n([\s\S]*?)\n:::$/gm;

/** Reads the tabs of a `:::tabs` block: each `== label` line starts a tab, and the rest of the tab is one code block. */
export const parseTabs = (block: string): readonly Tab[] =>
  block
    .split(/^== /m)
    .filter((part) => part.trim() !== "")
    .map((part) => {
      const newline = part.indexOf("\n");
      return { label: part.slice(0, newline).trim(), code: part.slice(newline + 1).trim() };
    });

export const replaceTabs = (body: string, render: (tabs: readonly Tab[], index: number) => string): string => {
  let index = 0;
  return body.replace(tabsPattern, (_block, inner: string) => render(parseTabs(inner), index++));
};

export const hasTabs = (body: string): boolean => new RegExp(tabsPattern.source, "m").test(body);

export const replaceLinks = (body: string, path: (href: string) => string): string => body.replace(/\]\((\/[^)\s]*)\)/g, (_link, href: string) => `](${path(href)})`);

/** `/guide/installation/` is `/guide/installation`. The index of a section keeps its slash: `/guide/`. */
export const withoutTrailingSlash = (href: string): string => {
  const segments = href.split("/").filter((segment) => segment !== "");
  const last = segments.at(-1);
  if (last === undefined || last === "guide" || last === "reference") return href;
  return `/${segments.join("/")}`;
};

const labelOf = (code: string, label: string): string => code.replace(/^```(\S+)/, (_fence, language: string) => `\`\`\`${language} [${label}]`);

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll('"', "&quot;");

export interface Output {
  readonly file: string;
  readonly source: string;
}

const frontmatter = (fields: Readonly<Record<string, string>>): string => ["---", ...Object.entries(fields).map(([key, value]) => `${key}: ${JSON.stringify(value)}`), "---", ""].join("\n");

/** VitePress: a code group for each tab block, the title as the `h1`, and paths without a trailing slash (`cleanUrls`). */
export const toVitePress = (page: FixturePage): Output => ({
  file: `${page.id}.md`,
  source: `${frontmatter({ title: page.title, description: page.description })}\n# ${page.title}\n\n${replaceTabs(replaceLinks(page.body, withoutTrailingSlash), (tabs) =>
    ["::: code-group", ...tabs.map((tab) => labelOf(tab.code, tab.label)), ":::"].join("\n\n"),
  )}\n`,
});

/** Starlight: the `<Tabs>` component in MDX, and the title from the frontmatter, as Starlight renders it. */
export const toStarlight = (page: FixturePage): Output => {
  const tabs = hasTabs(page.body);
  const body = replaceTabs(page.body, (items) => ["<Tabs>", ...items.map((tab) => `<TabItem label="${escapeHtml(tab.label)}">\n\n${tab.code}\n\n</TabItem>`), "</Tabs>"].join("\n"));
  const imports = tabs ? 'import { Tabs, TabItem } from "@astrojs/starlight/components";\n\n' : "";
  return { file: `${page.id}.${tabs ? "mdx" : "md"}`, source: `${frontmatter({ title: page.title, description: page.description })}\n${imports}${body}\n` };
};

/** Docus: numbered files for the order of the navigation, a `::code-group` for each tab block, images from `public/`, and paths without a trailing slash. */
export const toDocus = (page: FixturePage): Output => {
  const [folder, name] = page.id.split("/");
  const groupIndex = sidebar.findIndex((group) => group.items.includes(page.id));
  const itemIndex = groupIndex === -1 ? -1 : (sidebar[groupIndex]?.items.indexOf(page.id) ?? -1);
  const file = folder === undefined || name === undefined ? `${page.id}.md` : `${groupIndex + 1}.${folder}/${itemIndex + 1}.${name}.md`;
  const body = replaceTabs(replaceLinks(page.body, withoutTrailingSlash), (tabs) => ["::code-group", ...tabs.map((tab) => labelOf(tab.code, tab.label)), "::"].join("\n"));
  return { file, source: `${frontmatter({ title: page.title, description: page.description })}\n${body.replaceAll("](./hero.png)", "](/hero.png)")}\n` };
};

/** The framework: the title as the `h1`, and static tabs that `src/tabs.ts` of the app makes interactive after each page change. */
export const toFramework = (page: FixturePage): Output => ({
  file: `${page.id}.md`,
  source: `${frontmatter({ title: page.title, description: page.description })}\n# ${page.title}\n\n${replaceTabs(page.body, (tabs, group) =>
    [
      '<div class="tabs">',
      `<div role="tablist">${tabs.map((tab, index) => `<button type="button" role="tab" id="tab-${group}-${index}" aria-controls="panel-${group}-${index}" aria-selected="${index === 0}"${index === 0 ? "" : ' tabindex="-1"'}>${escapeHtml(tab.label)}</button>`).join("")}</div>`,
      ...tabs.map((tab, index) => `<div role="tabpanel" id="panel-${group}-${index}" aria-labelledby="tab-${group}-${index}"${index === 0 ? "" : " hidden"}>\n\n${tab.code}\n\n</div>`),
      "</div>",
    ].join("\n"),
  )}\n`,
});

