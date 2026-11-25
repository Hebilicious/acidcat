import { defineHastPlugin, markdownToHtml } from "satteri";
import type { HastNode, HastPluginList, MdastPluginList } from "satteri";
import { parse as parseYaml } from "yaml";
import { imageQuery, isConvertibleImage } from "./images.ts";
import type { Heading, PageData } from "./page.ts";

/** Colors one code block. It returns the HTML that replaces the `<pre>` element. */
export type Highlight = (code: string, language: string, meta: string) => string | Promise<string>;

export interface MarkdownOptions {
  /** Changes the source of a page before it is parsed, for example to expand a component into Markdown. */
  readonly transformSource?: (source: string, file: string) => string | Promise<string>;
  /** The id of a heading from its text. The default writes the slug that GitHub writes. */
  readonly slugify?: (text: string) => string;
  /** The levels of the headings in the table of contents of a page. */
  readonly headingLevels?: readonly number[];
  readonly highlight?: Highlight;
  readonly mdastPlugins?: MdastPluginList;
  readonly hastPlugins?: HastPluginList;
  /** Imports each image of the page that has a relative path with `?image`, so the image service of the Vite plugin converts it. */
  readonly images?: boolean;
}

export interface CompiledPage {
  /** A Vue single-file component in Vapor mode. */
  readonly sfc: string;
  readonly page: Omit<PageData, "path">;
}

export const githubSlug = (text: string): string =>
  text
    .trim()
    .toLowerCase()
    .replace(/[^\p{L}\p{M}\p{N}\p{Pc} -]/gu, "")
    .replace(/ /g, "-");

const blockPattern = /^<(script|style)\b([^>]*)>[\s\S]*?^<\/\1>[ \t]*$/gm;

const splitBlocks = (source: string): { readonly markdown: string; readonly blocks: readonly string[] } => {
  const blocks: string[] = [];
  const markdown = source.replace(blockPattern, (block) => {
    blocks.push(block);
    return "";
  });
  return { markdown, blocks };
};

const textOf = (node: HastNode): string => {
  if (node.type === "text") return node.value;
  if ("children" in node) return node.children.map((child) => textOf(child)).join("");
  return "";
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const readFrontmatter = (value: string | undefined): Record<string, unknown> => {
  if (value === undefined) return {};
  const data: unknown = parseYaml(value);
  if (data === null || data === undefined) return {};
  if (!isRecord(data)) throw new Error("The frontmatter of a page must be a YAML mapping.");
  return data;
};

const stringField = (frontmatter: Record<string, unknown>, key: string): string | undefined => {
  const value = frontmatter[key];
  return typeof value === "string" ? value : undefined;
};

/** Marks every element that Vue must not compile: code can hold `{{` and `<`, which are text. */
const preserveCode = defineHastPlugin({
  name: "vaporpress:preserve-code",
  element: {
    filter: ["pre", "code"],
    visit(node, context) {
      context.setProperty(node, "v-pre", "");
    },
  },
});

const highlightCode = (highlight: Highlight) =>
  defineHastPlugin({
    name: "vaporpress:highlight",
    element: {
      filter: ["pre"],
      async visit(node, context) {
        const code = node.children.find((child) => child.type === "element" && child.tagName === "code");
        if (code === undefined || code.type !== "element") return;
        const data = code.data;
        const language = isRecord(data) && typeof data["lang"] === "string" ? data["lang"] : "";
        const meta = isRecord(data) && typeof data["meta"] === "string" ? data["meta"] : "";
        const html = await highlight(textOf(code), language, meta);
        context.replaceNode(node, { type: "raw", value: html.replace(/^<pre\b/, "<pre v-pre") });
      },
    },
  });

const isRelativePath = (src: string): boolean => !/^(?:[a-z][a-z\d+.-]*:|\/|#)/i.test(src);

/**
 * Gives each `<img>` with a relative path to a PNG, JPEG, WebP, AVIF or TIFF file the attributes of the image service.
 * The first image of a page loads at once, because it can be the largest element on screen. The others load when they
 * come near the screen.
 */
const serveImages = (imports: string[]) =>
  defineHastPlugin({
    name: "vaporpress:images",
    element: {
      filter: ["img"],
      visit(node, context) {
        const src = node.properties["src"];
        if (typeof src !== "string" || !isRelativePath(src) || !isConvertibleImage(src)) return;
        const name = `__vaporpressImage${imports.length}`;
        imports.push(`import ${name} from ${JSON.stringify(`${decodeURI(src)}${imageQuery}`)};`);
        const properties = Object.fromEntries(Object.entries(node.properties).filter(([key]) => key !== "src"));
        context.setField(node, "properties", { ...properties, "v-bind": name, decoding: "async", ...(imports.length > 1 ? { loading: "lazy" } : {}) });
      },
    },
  });

const collectHeadings = (slugify: (text: string) => string, levels: ReadonlySet<number>, headings: Heading[], title: { value: string | undefined }) => {
  const used = new Map<string, number>();
  return defineHastPlugin({
    name: "vaporpress:headings",
    element: {
      filter: ["h1", "h2", "h3", "h4", "h5", "h6"],
      visit(node, context) {
        const level = Number(node.tagName.slice(1));
        const text = textOf(node).trim();
        if (level === 1) title.value ??= text;
        const given = node.properties["id"];
        let slug = typeof given === "string" ? given : slugify(text);
        const count = used.get(slug) ?? 0;
        used.set(slug, count + 1);
        if (count > 0) slug = `${slug}-${count}`;
        context.setProperty(node, "id", slug);
        if (levels.has(level)) headings.push({ level, slug, title: text });
      },
    },
  });
};

const isSetup = (block: string): boolean => /^<script\b[^>]*\bsetup\b/.test(block);

const withVapor = (block: string): string => (/^<script\b[^>]*\bvapor\b/.test(block) ? block : block.replace(/^<script\b/, "<script vapor"));

const withImports = (block: string, imports: readonly string[]): string => (imports.length === 0 ? block : block.replace(/^<script\b[^>]*>/, (tag) => `${tag}\n${imports.join("\n")}`));

/** The page data rides on the component, so that the layout reads it from the route that the router resolved. */
const pageScript = (block: string | undefined, page: Omit<PageData, "path">, file: string): string => {
  const exportPage = `export default { __page: ${JSON.stringify(page)} }`;
  if (block === undefined) return `<script>\n${exportPage}\n</script>`;
  if (/\bexport\s+default\b/.test(block)) throw new Error(`${file}: the <script> block of a Markdown page cannot have a default export.`);
  return block.replace(/<\/script>[ \t]*$/, `${exportPage}\n</script>`);
};

/** Compiles a Markdown page into a Vue component in Vapor mode, and reads its data. */
export const compileMarkdown = async (source: string, file: string, options: MarkdownOptions = {}): Promise<CompiledPage> => {
  const transformed = options.transformSource === undefined ? source : await options.transformSource(source, file);
  const { markdown, blocks } = splitBlocks(transformed);
  const headings: Heading[] = [];
  const title: { value: string | undefined } = { value: undefined };
  const imports: string[] = [];
  const result = await markdownToHtml(markdown, {
    features: { gfm: true, frontmatter: true, attributes: true },
    ...(options.mdastPlugins === undefined ? {} : { mdastPlugins: options.mdastPlugins }),
    hastPlugins: [
      collectHeadings(options.slugify ?? githubSlug, new Set(options.headingLevels ?? [2, 3]), headings, title),
      ...(options.hastPlugins ?? []),
      ...(options.images === true ? [serveImages(imports)] : []),
      ...(options.highlight === undefined ? [] : [highlightCode(options.highlight)]),
      preserveCode,
    ],
  });
  const frontmatter = readFrontmatter(result.frontmatter?.value);
  const description = stringField(frontmatter, "description");
  const page: Omit<PageData, "path"> = {
    title: stringField(frontmatter, "title") ?? title.value ?? "",
    ...(description === undefined ? {} : { description }),
    frontmatter,
    headings,
  };
  const scripts = blocks.filter((block) => block.startsWith("<script"));
  const styles = blocks.filter((block) => block.startsWith("<style"));
  const setup = scripts.find((block) => isSetup(block));
  const plain = scripts.filter((block) => !isSetup(block));
  if (plain.length > 1 || scripts.length - plain.length > 1) throw new Error(`${file} has more than one <script> or <script setup> block.`);
  const sfc = [
    pageScript(plain[0], page, file),
    withImports(setup === undefined ? "<script setup vapor></script>" : withVapor(setup), imports),
    `<template>${result.html}</template>`,
    ...styles,
  ].join("\n");
  return { sfc, page };
};
