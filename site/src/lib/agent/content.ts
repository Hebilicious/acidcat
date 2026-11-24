import * as z from "zod/mini";

export const Section = z.enum(["home", "docs", "examples", "spec", "packages"]).check(z.meta({ id: "Section" }));

const described = (text: string) => z.string().check(z.describe(text));

export const PageSummary = z
  .object({
    path: described("The path of the page on the site, for example /docs/quick-start/."),
    title: z.string(),
    description: z.string(),
    section: Section,
  })
  .check(z.meta({ id: "PageSummary" }));

export const Page = z.extend(PageSummary, { markdown: described("The content of the page as Markdown.") });

export const Package = z
  .object({
    name: z.string(),
    registry: z.enum(["npm", "crates.io", "PyPI", "Go", "Pkl"]),
    version: described("The released version in the repository."),
    description: z.string(),
    install: described("The command that installs the package."),
    url: described("The page of the package on its registry."),
  })
  .check(z.meta({ id: "Package" }));

export const SiteContent = z.object({ pages: z.array(Page), packages: z.array(Package) });
export type SiteContent = z.infer<typeof SiteContent>;
export type Page = z.infer<typeof Page>;

export const CONTENT_PATH = "/content.json";

export type ReadPath = (path: string) => Promise<Response>;

export interface SiteContext {
  readonly content: () => Promise<SiteContent>;
}

export const siteContext = (read: ReadPath): SiteContext => {
  let loading: Promise<SiteContent> | undefined;
  const load = async (): Promise<SiteContent> => {
    const response = await read(CONTENT_PATH);
    if (!response.ok) throw new Error(`${CONTENT_PATH} answered ${response.status}.`);
    return SiteContent.parse(await response.json());
  };
  return {
    content: () => {
      loading ??= load().catch((error: unknown) => {
        loading = undefined;
        throw error;
      });
      return loading;
    },
  };
};

export const normalizePath = (path: string): string => {
  const pathname = URL.canParse(path) ? new URL(path).pathname : path.split(/[?#]/, 1)[0] ?? "";
  const trimmed = pathname.replace(/\/index\.(md|html)$/, "/").replace(/^\/*/, "/");
  return trimmed.endsWith("/") ? trimmed : `${trimmed}/`;
};

const terms = (query: string): string[] => query.toLowerCase().split(/\s+/).filter((term) => term !== "");

const count = (text: string, term: string): number => text.split(term).length - 1;

const weight = { title: 10, description: 3, markdown: 1 } as const;

const excerpt = (markdown: string, term: string): string => {
  const at = Math.max(0, markdown.toLowerCase().indexOf(term));
  const start = Math.max(0, at - 80);
  const text = markdown.slice(start, at + 160).replace(/\s+/g, " ").trim();
  return `${start > 0 ? "…" : ""}${text}${at + 160 < markdown.length ? "…" : ""}`;
};

export interface SearchResult {
  readonly path: string;
  readonly title: string;
  readonly excerpt: string;
}

export const search = (pages: readonly Page[], query: string, limit: number): SearchResult[] => {
  const words = terms(query);
  const [first] = words;
  if (first === undefined) return [];
  return pages
    .map((page) => {
      const title = page.title.toLowerCase();
      const description = page.description.toLowerCase();
      const markdown = page.markdown.toLowerCase();
      const found = words.every((word) => title.includes(word) || description.includes(word) || markdown.includes(word));
      const score = words.reduce((total, word) => total + weight.title * count(title, word) + weight.description * count(description, word) + weight.markdown * count(markdown, word), 0);
      return { page, score: found ? score : 0 };
    })
    .filter(({ score }) => score > 0)
    .sort((a, b) => b.score - a.score || a.page.path.localeCompare(b.page.path))
    .slice(0, limit)
    .map(({ page }) => ({ path: page.path, title: page.title, excerpt: excerpt(page.markdown, first) }));
};
