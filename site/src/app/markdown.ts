import { defineHastPlugin, hastText } from "vaporpress/markdown";
import { bundledLanguages, createHighlighter } from "shiki";
import type { ShikiTransformer } from "shiki";
import { codeTheme } from "../lib/code-theme.ts";
import { codeFrame, frameTitle } from "../lib/markdown/code-frame.ts";
import { isExternal } from "../lib/external-links.ts";

const highlighter = await createHighlighter({ themes: [codeTheme], langs: [] });

const isBundledLanguage = (language: string): language is keyof typeof bundledLanguages => language in bundledLanguages;

const shellLanguages: ReadonlySet<string> = new Set(["shellscript", "shell", "bash", "sh", "zsh"]);

const unselectablePrompt: ShikiTransformer = {
  name: "acidcat:unselectable-prompt",
  tokens(lines) {
    if (!shellLanguages.has(this.options.lang)) return;
    for (const [prompt, next] of lines) {
      const symbol = prompt?.content.trim();
      if (prompt === undefined || next === undefined || (symbol !== "$" && symbol !== ">") || !next.content.startsWith(" ")) continue;
      prompt.content = `${symbol} `;
      prompt.htmlStyle = { ...prompt.htmlStyle, "user-select": "none", "-webkit-user-select": "none" };
      next.content = next.content.slice(1);
    }
  },
};

const colored = async (code: string, language: string): Promise<string> => {
  const lang = isBundledLanguage(language) ? language : "text";
  if (lang !== "text") await highlighter.loadLanguage(lang);
  return highlighter.codeToHtml(code.replace(/\n$/, ""), { lang, theme: codeTheme.name ?? "acidcat", transformers: [unselectablePrompt] }).replace(/^<pre /, '<pre dir="ltr" ');
};

export const highlightBlock = async (code: string, language: string, meta: string): Promise<string> => codeFrame(await colored(code, language), language, frameTitle(meta));

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
