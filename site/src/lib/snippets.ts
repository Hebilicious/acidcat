import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { createCssVariablesTheme, createHighlighter } from "shiki";

const repository = join(process.cwd(), "..");

const dedent = (lines: readonly string[]): string => {
  const indents = lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length);
  const cut = Math.min(...indents);
  return lines.map((line) => line.slice(cut)).join("\n");
};

const block = async (file: string, start: RegExp, end: RegExp, before = 0): Promise<string> => {
  const lines = (await readFile(join(repository, file), "utf8")).split("\n");
  const first = lines.findIndex((line) => start.test(line)) - before;
  if (first < 0) throw new Error(`No match for ${start} in ${file}.`);
  const last = lines.findIndex((line, index) => index > first + before && end.test(line));
  if (last < 0) throw new Error(`No end for ${start} in ${file}.`);
  return dedent(lines.slice(first, last + 1));
};

const fence = async (file: string, language: string, from?: RegExp): Promise<string> => {
  const text = await readFile(join(repository, file), "utf8");
  const match = new RegExp("```" + language + "[^\\n]*\\n([\\s\\S]*?)\\n```").exec(text);
  if (match?.[1] === undefined) throw new Error(`No ${language} block in ${file}.`);
  if (from === undefined) return match[1];
  const lines = match[1].split("\n");
  const first = lines.findIndex((line) => from.test(line));
  if (first < 0) throw new Error(`No match for ${from} in ${file}.`);
  return lines.slice(first).join("\n");
};

export interface Snippet {
  readonly id: string;
  readonly label: string;
  readonly language: string;
  readonly source: string;
  readonly code: string;
}

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const canonical = async (): Promise<string> => {
  const text = await readFile(join(repository, "examples/aircon/catalog/aircon.acidcat.json"), "utf8");
  const parsed: unknown = JSON.parse(text);
  const capabilities = isRecord(parsed) ? parsed["capabilities"] : undefined;
  const entry = isRecord(capabilities) ? capabilities["aircon.power.set"] : undefined;
  if (!isRecord(entry)) throw new Error("aircon.power.set is not in the catalog.");
  return `"aircon.power.set": ${JSON.stringify(entry, null, 2)}`;
};

const joined = async (...parts: Promise<string>[]): Promise<string> => (await Promise.all(parts)).join("\n\n");

export const catalogSnippets = async (): Promise<Snippet[]> => [
  {
    id: "ts",
    label: "TypeScript",
    language: "typescript",
    source: "examples/aircon/catalog/typescript.ts",
    code: await joined(
      block("examples/aircon/catalog/typescript.ts", /const setting = \(name: string/, /^\s*\}\);$/),
      block("examples/aircon/catalog/typescript.ts", /\.capability\("aircon\.power\.set"/, /^\s*\}\)$/),
    ),
  },
  {
    id: "py",
    label: "Python",
    language: "python",
    source: "examples/aircon/catalog/python.py",
    code: await joined(
      block("examples/aircon/catalog/python.py", /def setting\(name: str/, /return \{"type": "object"/),
      block("examples/aircon/catalog/python.py", /^\s+"aircon\.power\.set",$/, /^\s*\)$/, 1),
    ),
  },
  {
    id: "go",
    label: "Go",
    language: "go",
    source: "examples/aircon/catalog/go/main.go",
    code: await joined(
      block("examples/aircon/catalog/go/main.go", /setting := func\(name string/, /offlineOnly :=/),
      block("examples/aircon/catalog/go/main.go", /Capability\("aircon\.power\.set"/, /^\s*\}\)\.$/),
    ),
  },
  {
    id: "rs",
    label: "Rust",
    language: "rust",
    source: "examples/aircon/catalog/rust/src/main.rs",
    code: await joined(
      block("examples/aircon/catalog/rust/src/main.rs", /let setting = \|name: &str/, /let offline_only = /),
      block("examples/aircon/catalog/rust/src/main.rs", /\.capability\("aircon\.power\.set"/, /^\s*\}\)$/),
    ),
  },
  {
    id: "pkl",
    label: "Pkl",
    language: "pkl",
    source: "examples/aircon/catalog/aircon.pkl",
    code: await joined(
      block("examples/aircon/catalog/aircon.pkl", /^local function setting\(/, /^\}$/),
      block("examples/aircon/catalog/aircon.pkl", /\["aircon\.power\.set"\]/, /^\s{2}\}$/),
    ),
  },
];

export const canonicalSnippet = async (): Promise<Snippet> => ({
  id: "json",
  label: "JSON",
  language: "json",
  source: "examples/aircon/catalog/aircon.acidcat.json",
  code: await canonical(),
});

export const coreSnippets = async (): Promise<Snippet[]> => [
  { id: "core-ts", label: "TypeScript", language: "typescript", source: "packages/core-ts/README.md", code: await fence("packages/core-ts/README.md", "ts") },
  { id: "core-effect", label: "Effect", language: "typescript", source: "packages/core-effect/README.md", code: await fence("packages/core-effect/README.md", "ts") },
  { id: "core-rust", label: "Rust", language: "rust", source: "packages/core-rust/README.md", code: await fence("packages/core-rust/README.md", "rust", /^#\[tokio::main\]/) },
];

const theme = createCssVariablesTheme({ name: "acidcat", variablePrefix: "--code-", fontStyle: true });
const highlighter = await createHighlighter({ themes: [theme], langs: ["typescript", "python", "go", "rust", "pkl", "json", "shellscript", "http"] });

export const highlight = (code: string, language: string): string => highlighter.codeToHtml(code, { lang: language, theme: "acidcat" });
