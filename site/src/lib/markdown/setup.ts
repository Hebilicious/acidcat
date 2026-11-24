import { join, relative } from "node:path";
import type { MarkdownEnv, MarkdownRenderer } from "vitepress";
import { readPublishedPackages } from "../packages.ts";
import type { SpecPage } from "../spec-pages.ts";
import { specRoute } from "../spec-pages.ts";
import { codeFrame, frameTitle, withoutTitle } from "./code-frame.ts";
import { expandComponents } from "./components.ts";

/** Puts each code block in a frame. */
const codeFrames = (md: MarkdownRenderer): void => {
  const fence = md.renderer.rules.fence;
  if (fence === undefined) throw new Error("The Markdown renderer has no fence rule.");
  md.renderer.rules.fence = (tokens, index, options, env, self) => {
    const token = tokens[index];
    if (token === undefined) return "";
    const title = frameTitle(token.info);
    token.info = withoutTitle(token.info);
    const language = /^[\w-]+/.exec(token.info)?.[0] ?? "";
    return codeFrame(fence(tokens, index, options, env, self), language, title);
  };
};

const contentOf = (repositoryRoot: string) => join(repositoryRoot, "site/content");

/** Renders the components of the docs before each page, and frames the code blocks. */
export const markdownSetup = (md: MarkdownRenderer, repositoryRoot: string): void => {
  codeFrames(md);
  const render = md.renderAsync.bind(md);
  md.renderAsync = async (source: string, env?: MarkdownEnv) =>
    render(await expandComponents(source, { page: env === undefined ? "site/content" : relative(repositoryRoot, env.path), repositoryRoot, content: contentOf(repositoryRoot) }), env);
};

const packagesMarkdown = async (repositoryRoot: string): Promise<string> => {
  const packages = await readPublishedPackages(repositoryRoot);
  return packages.map((entry) => `## ${entry.title}\n\n${entry.description}\n\n\`${entry.install}\``).join("\n\n");
};

/**
 * The local search reads each page from its file. A page of the specification has no file, and the packages
 * page has its content in a component, so the search gets their Markdown here. Each page gets its title as a heading.
 */
export const searchRender =
  (repositoryRoot: string, specPages: readonly SpecPage[]) =>
  async (source: string, env: MarkdownEnv, md: MarkdownRenderer): Promise<string> => {
    const path = env.relativePath ?? "";
    if (path === "index.md") return "";
    const spec = specPages.find((page) => `spec/${specRoute(page.id)}.md` === path);
    if (spec !== undefined) return md.renderAsync(`# ${spec.title}\n\n${spec.body}`, env);
    if (path === "packages/index.md") return md.renderAsync(`# Packages\n\n${await packagesMarkdown(repositoryRoot)}`, env);
    const html = await md.renderAsync(source, env);
    if (env.frontmatter?.["search"] === false) return "";
    const title = typeof env.frontmatter?.["title"] === "string" ? env.frontmatter["title"] : "";
    return `${await md.renderAsync(`# ${title}`, { ...env, frontmatter: {} })}${html}`;
  };
