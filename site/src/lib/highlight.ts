import { createCssVariablesTheme, createHighlighter } from "shiki";
import { fileLanguages } from "./example-files.ts";

const theme = createCssVariablesTheme({ name: "acidcat", variablePrefix: "--code-", fontStyle: true });
const highlighter = await createHighlighter({ themes: [theme], langs: [...new Set(["typescript", "python", "go", "rust", "pkl", "json", "shellscript", "http", ...fileLanguages])] });

export const highlight = (code: string, language: string): string => highlighter.codeToHtml(code, { lang: language, theme: "acidcat" });
