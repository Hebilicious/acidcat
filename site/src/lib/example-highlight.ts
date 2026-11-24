import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createHighlighter } from "shiki";
import { codeTheme } from "./code-theme.ts";
import { repositoryRoot } from "./ecosystem.ts";
import { fileKind, fileLanguages, sourcePath } from "./example-files.ts";

const highlighter = await createHighlighter({ themes: [codeTheme], langs: [...fileLanguages] });

export const highlightExampleFile = async (example: string, file: string, repository = repositoryRoot): Promise<string> => {
  const code = await readFile(join(repository, sourcePath(example, file)), "utf8");
  return highlighter.codeToHtml(code.replace(/\n$/, ""), { lang: fileKind(file).lang, theme: "acidcat" });
};
