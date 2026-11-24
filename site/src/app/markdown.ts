import { defineHastPlugin, hastText } from "vaporpress/markdown";
import { bundledLanguages, createHighlighter } from "shiki";
import { codeTheme } from "../lib/code-theme.ts";
import { isExternal } from "../lib/external-links.ts";

const terminalLanguages: ReadonlySet<string> = new Set(["sh", "bash", "shell", "shellscript", "zsh", "console", "powershell"]);
const highlighter = await createHighlighter({ themes: [codeTheme], langs: [] });

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const isBundledLanguage = (language: string): language is keyof typeof bundledLanguages => language in bundledLanguages;

const colored = async (code: string, language: string): Promise<string> => {
  const lang = isBundledLanguage(language) ? language : "text";
  if (lang !== "text") await highlighter.loadLanguage(lang);
  return highlighter.codeToHtml(code.replace(/\n$/, ""), { lang, theme: codeTheme.name ?? "acidcat" }).replace(/^<pre /, '<pre dir="ltr" ');
};

/** Puts each code block in a frame: an editor tab when it has a title, a terminal for a shell, and a copy button. */
export const highlightBlock = async (code: string, language: string, meta: string): Promise<string> => {
  const title = /(?:^|\s)title="([^"]*)"/.exec(meta)?.[1];
  const terminal = terminalLanguages.has(language);
  const classes = ["frame", ...(title === undefined ? [] : ["has-title"]), ...(terminal ? ["is-terminal"] : [])].join(" ");
  const header = title !== undefined || terminal ? `<figcaption class="header"><span class="title">${escapeHtml(title ?? "")}</span></figcaption>` : "";
  const copy = '<div class="copy"><button type="button" title="Copy to clipboard" data-copy-code><span class="sr-only">Copy to clipboard</span></button></div>';
  return `<div class="code-block not-content"><figure class="${classes}" data-language="${escapeHtml(language)}">${header}${await colored(code, language)}${copy}</figure></div>`;
};

/** Adds a link to each heading. Its label names the heading, and CSS draws its mark, so the text of the heading has no extra character. */
export const headingAnchors = defineHastPlugin({
  name: "acidcat:heading-anchors",
  element: {
    filter: ["h2", "h3", "h4", "h5", "h6"],
    visit(node, context) {
      const id = node.properties["id"];
      if (typeof id !== "string") return;
      context.setProperty(node, "tabIndex", -1);
      context.appendChild(node, {
        type: "element",
        tagName: "a",
        properties: { className: ["header-anchor"], href: `#${id}`, ariaLabel: `Permalink to “${hastText(node).trim()}”` },
        children: [],
      });
    },
  },
});

/** Opens each link to another website in a new tab. */
export const externalLinks = defineHastPlugin({
  name: "acidcat:external-links",
  element: {
    filter: ["a"],
    visit(node, context) {
      if (!isExternal(node.properties["href"])) return;
      context.setProperty(node, "target", "_blank");
      context.setProperty(node, "rel", ["noopener", "noreferrer"]);
    },
  },
});
