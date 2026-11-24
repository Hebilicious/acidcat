import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { catalogDirectory, catalogLanguages, exampleFor, repositoryRoot } from "./ecosystem.ts";
import type { CatalogLanguage } from "./ecosystem.ts";

type EntryKind = "target" | "type" | "capability" | "event";

export interface CatalogSelection {
  readonly target?: string | readonly string[] | undefined;
  readonly type?: string | readonly string[] | undefined;
  readonly capability?: string | readonly string[] | undefined;
  readonly event?: string | readonly string[] | undefined;
  readonly header?: boolean | undefined;
}

export interface CatalogExample {
  readonly id: string;
  readonly label: string;
  readonly lang: string;
  readonly title: string;
  readonly code: string;
}

interface Entry {
  readonly kind: EntryKind;
  readonly id: string;
}

interface Helper {
  readonly uses: RegExp;
  readonly start: RegExp;
}

interface CodeSource {
  readonly kind: "code";
  readonly header: readonly RegExp[];
  readonly calls: Readonly<Record<EntryKind, string>>;
  readonly helpers: readonly Helper[];
}

interface PklSource {
  readonly kind: "pkl";
  readonly header: readonly RegExp[];
  readonly helpers: readonly Helper[];
}

type Source = CodeSource | PklSource;

const kinds: readonly EntryKind[] = ["target", "type", "capability", "event"];

const sources: Readonly<Partial<Record<string, Source>>> = {
  typescript: {
    kind: "code",
    header: [/^import \{ Catalog\b/, /const catalog = new Catalog\(/],
    calls: { target: "\\.target", type: "catalog\\.type", capability: "\\.capability", event: "\\.event" },
    helpers: [{ uses: /\bsetting\(/, start: /const setting = \(/ }],
  },
  python: {
    kind: "code",
    header: [/^from acid_cat_catalog import/, /catalog = Catalog\(/],
    calls: { target: "catalog\\.target", type: "catalog\\.type", capability: "catalog\\.capability", event: "catalog\\.event" },
    helpers: [{ uses: /\bsetting\(/, start: /def setting\(/ }],
  },
  go: {
    kind: "code",
    header: [/^import \($/, /c := catalog\.New\(/],
    calls: { target: "\\bTarget", type: "c\\.Type", capability: "\\bCapability", event: "\\bEvent" },
    helpers: [
      { uses: /\bsetting\(/, start: /setting := func\(/ },
      { uses: /\bofflineOnly\b/, start: /offlineOnly :=/ },
    ],
  },
  rust: {
    kind: "code",
    header: [/^use acid_cat_catalog::/, /let mut catalog = Catalog::new\(/],
    calls: { target: "\\.target", type: "catalog\\.r#type", capability: "\\.capability", event: "\\.event" },
    helpers: [
      { uses: /\bsetting\(/, start: /let setting = \|/ },
      { uses: /\boffline_only\(/, start: /let offline_only = / },
    ],
  },
  pkl: {
    kind: "pkl",
    header: [/^amends /, /^title = /, /^description = /],
    helpers: [{ uses: /\bsetting\(/, start: /^local function setting\(/ }],
  },
};

const pklSections: Readonly<Record<EntryKind, string>> = { target: "targets", type: "types", capability: "capabilities", event: "events" };
const jsonSections: Readonly<Record<EntryKind, string>> = { target: "targets", type: "$defs", capability: "capabilities", event: "events" };
const jsonHeader: readonly string[] = ["acidcat", "title", "description"];

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const list = (value: string | readonly string[] | undefined): readonly string[] => (value === undefined ? [] : typeof value === "string" ? [value] : value);

const entriesOf = (selection: CatalogSelection): readonly Entry[] => {
  const entries = kinds.flatMap((kind) => list(selection[kind]).map((id) => ({ kind, id })));
  if (entries.length === 0 && selection.header !== true) throw new Error("A catalog example needs the header, a target, a type, a capability or an event.");
  return entries;
};

const dedent = (lines: readonly string[]): string => {
  const indents = lines.filter((line) => line.trim() !== "").map((line) => line.length - line.trimStart().length);
  const cut = Math.min(...indents);
  return lines.map((line) => line.slice(cut)).join("\n");
};

const depthChange = (line: string): number => {
  let change = 0;
  let quoted = false;
  for (let index = 0; index < line.length; index += 1) {
    const character = line[index];
    if (quoted) {
      if (character === "\\") index += 1;
      else if (character === '"') quoted = false;
    } else if (character === '"') quoted = true;
    else if (character === "(" || character === "{" || character === "[") change += 1;
    else if (character === ")" || character === "}" || character === "]") change -= 1;
  }
  return change;
};

const indentOf = (line: string): number => line.length - line.trimStart().length;

const statementEnd = (lines: readonly string[], first: number): number => {
  let depth = 0;
  let last = first;
  for (; last < lines.length; last += 1) {
    const line = lines[last] ?? "";
    depth += depthChange(line);
    if (depth <= 0 && !line.trimEnd().endsWith("=")) break;
  }
  const opener = lines[first] ?? "";
  if (opener.trimEnd().endsWith(":")) {
    while (last + 1 < lines.length) {
      const next = lines[last + 1] ?? "";
      if (next.trim() !== "" && indentOf(next) <= indentOf(opener)) break;
      last += 1;
    }
  }
  while (last > first && (lines[last] ?? "").trim() === "") last -= 1;
  return last;
};

export const statementAt = (lines: readonly string[], first: number): readonly string[] => lines.slice(first, statementEnd(lines, first) + 1);

const findCall = (lines: readonly string[], call: string, id: string): number => {
  const sameLine = new RegExp(`${call}\\(\\s*"${escape(id)}"`);
  const opener = new RegExp(`${call}\\($`);
  const argument = new RegExp(`^\\s*"${escape(id)}",`);
  return lines.findIndex((line, index) => sameLine.test(line) || (opener.test(line) && argument.test(lines[index + 1] ?? "")));
};

const findPkl = (lines: readonly string[], section: string, id: string): number => {
  const header = lines.findIndex((line) => line === `${section} {`);
  if (header < 0) return -1;
  const key = new RegExp(`^\\s*\\["${escape(id)}"\\]`);
  return lines.findIndex((line, index) => index > header && key.test(line));
};

const missing = (file: string, entry: Entry): Error =>
  new Error(`${file} has no ${entry.kind} "${entry.id}". Change the docs page, or the pattern in site/src/lib/catalog-examples.ts.`);

const noMatch = (file: string, pattern: RegExp): Error => new Error(`${file} has no line that matches ${pattern}. Change the pattern in site/src/lib/catalog-examples.ts.`);

const helperBlocks = (lines: readonly string[], file: string, helpers: readonly Helper[], blocks: readonly string[]): string[] =>
  helpers
    .filter((helper) => blocks.some((block) => helper.uses.test(block)))
    .map((helper) => {
      const first = lines.findIndex((line) => helper.start.test(line));
      if (first < 0) throw noMatch(file, helper.start);
      return dedent(statementAt(lines, first));
    });

const headerBlocks = (lines: readonly string[], file: string, patterns: readonly RegExp[]): string[] => {
  const ranges = patterns.map((pattern) => {
    const first = lines.findIndex((line) => pattern.test(line));
    if (first < 0) throw noMatch(file, pattern);
    return { first, last: statementEnd(lines, first) };
  });
  const merged: { first: number; last: number }[] = [];
  for (const range of ranges) {
    const previous = merged.at(-1);
    const gap = previous === undefined ? [] : lines.slice(previous.last + 1, range.first);
    if (previous !== undefined && range.first > previous.last && gap.every((line) => line.trim() === "")) previous.last = range.last;
    else merged.push({ ...range });
  }
  return merged.map((range) => dedent(lines.slice(range.first, range.last + 1)));
};

const read = async (repository: string, file: string): Promise<string> => readFile(join(repository, file), "utf8");

const titleOf = (file: string): string => file.slice(catalogDirectory.length + 1);

const codeExample = async (repository: string, language: CatalogLanguage, source: CodeSource, entries: readonly Entry[], header: boolean): Promise<CatalogExample> => {
  const lines = (await read(repository, language.example)).split("\n");
  const blocks = entries.map((entry) => {
    const first = findCall(lines, source.calls[entry.kind], entry.id);
    if (first < 0) throw missing(language.example, entry);
    return dedent(statementAt(lines, first));
  });
  const top = header ? headerBlocks(lines, language.example, source.header) : [];
  const code = [...top, ...helperBlocks(lines, language.example, source.helpers, blocks), ...blocks].join("\n\n");
  return { id: language.id, label: language.label, lang: language.lang, title: titleOf(language.example), code };
};

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");

const pklExample = async (repository: string, language: CatalogLanguage, source: PklSource, entries: readonly Entry[], header: boolean): Promise<CatalogExample> => {
  const lines = (await read(repository, language.example)).split("\n");
  const sections = kinds.flatMap((kind) => {
    const blocks = entries
      .filter((entry) => entry.kind === kind)
      .map((entry) => {
        const first = findPkl(lines, pklSections[kind], entry.id);
        if (first < 0) throw missing(language.example, entry);
        return dedent(statementAt(lines, first));
      });
    return blocks.length === 0 ? [] : [`${pklSections[kind]} {\n${indent(blocks.join("\n\n"))}\n}`];
  });
  const top = header ? headerBlocks(lines, language.example, source.header) : [];
  const helpers = helperBlocks(lines, language.example, source.helpers, sections);
  return { id: language.id, label: language.label, lang: language.lang, title: titleOf(language.example), code: [...top, ...helpers, ...sections].join("\n\n") };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const jsonExample = async (repository: string, entries: readonly Entry[], header: boolean): Promise<CatalogExample> => {
  const file = `${catalogDirectory}/aircon.acidcat.json`;
  const parsed: unknown = JSON.parse(await read(repository, file));
  if (!isRecord(parsed)) throw new Error(`${file} is not a JSON object.`);
  const fragment: Record<string, unknown> = {};
  if (header) for (const member of jsonHeader) if (parsed[member] !== undefined) fragment[member] = parsed[member];
  for (const kind of kinds) {
    for (const entry of entries.filter((candidate) => candidate.kind === kind)) {
      const section = parsed[jsonSections[kind]];
      const value = isRecord(section) ? section[entry.id] : undefined;
      if (value === undefined) throw missing(file, entry);
      const existing = fragment[jsonSections[kind]];
      fragment[jsonSections[kind]] = { ...(isRecord(existing) ? existing : {}), [entry.id]: value };
    }
  }
  return { id: "json", label: "JSON", lang: "json", title: titleOf(file), code: JSON.stringify(fragment, null, 2) };
};

const languageExample = (repository: string, language: CatalogLanguage, entries: readonly Entry[], header: boolean): Promise<CatalogExample> => {
  const source = exampleFor(sources, language, "site/src/lib/catalog-examples.ts");
  return source.kind === "pkl" ? pklExample(repository, language, source, entries, header) : codeExample(repository, language, source, entries, header);
};

export const catalogExamples = async (selection: CatalogSelection, repository = repositoryRoot): Promise<CatalogExample[]> => {
  const entries = entriesOf(selection);
  const header = selection.header === true;
  return Promise.all([...catalogLanguages.map((language) => languageExample(repository, language, entries, header)), jsonExample(repository, entries, header)]);
};
