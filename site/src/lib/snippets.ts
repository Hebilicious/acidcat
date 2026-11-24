import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { catalogExamples } from "./catalog-examples.ts";
import { catalogLanguages, cores, exampleFor, repositoryRoot as repository } from "./ecosystem.ts";
import { fences } from "./markdown-fences.ts";

const fence = async (file: string, language: string, from?: RegExp): Promise<string> => {
  const code = fences(await readFile(join(repository, file), "utf8")).find((candidate) => candidate.language === language)?.code;
  if (code === undefined) throw new Error(`No ${language} block in ${file}.`);
  if (from === undefined) return code;
  const lines = code.split("\n");
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

export const catalogSnippets = async (): Promise<Snippet[]> => {
  const examples = await catalogExamples({ capability: "aircon.power.set" });
  return catalogLanguages.map((language) => {
    const example = examples.find((candidate) => candidate.id === language.id);
    if (example === undefined) throw new Error(`No catalog example for "${language.id}".`);
    return { id: language.abbreviation, label: language.label, language: language.lang, source: language.example, code: example.code };
  });
};

export const canonicalSnippet = async (): Promise<Snippet> => ({
  id: "json",
  label: "JSON",
  language: "json",
  source: "examples/aircon/catalog/aircon.acidcat.json",
  code: await canonical(),
});

interface ReadmeFence {
  readonly language: string;
  readonly from?: RegExp;
}

const coreFences: Readonly<Partial<Record<string, ReadmeFence>>> = {
  "core-ts": { language: "ts" },
  "core-effect": { language: "ts" },
  "core-rust": { language: "rust", from: /^#\[tokio::main\]/ },
};

export const coreSnippets = async (): Promise<Snippet[]> =>
  Promise.all(
    cores.map(async (core) => {
      const readme = exampleFor(coreFences, core, "site/src/lib/snippets.ts");
      return { id: core.id, label: core.label, language: core.lang, source: core.readme, code: await fence(core.readme, readme.language, readme.from) };
    }),
  );
