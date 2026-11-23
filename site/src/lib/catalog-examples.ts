import { readFile } from "node:fs/promises";
import { join } from "node:path";

type EntryKind = "target" | "type" | "capability" | "event";

export interface CatalogSelection {
  readonly target?: string | readonly string[] | undefined;
  readonly type?: string | readonly string[] | undefined;
  readonly capability?: string | readonly string[] | undefined;
  readonly event?: string | readonly string[] | undefined;
}

export interface CatalogExample {
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

interface Source {
  readonly label: string;
  readonly lang: string;
  readonly file: string;
  readonly calls: Readonly<Record<EntryKind, string>>;
  readonly helpers: readonly Helper[];
}

const catalogDirectory = "examples/aircon/catalog";

const kinds: readonly EntryKind[] = ["target", "type", "capability", "event"];

const sources: readonly Source[] = [
  {
    label: "TypeScript",
    lang: "ts",
    file: "typescript.ts",
    calls: { target: "\\.target", type: "catalog\\.type", capability: "\\.capability", event: "\\.event" },
    helpers: [{ uses: /\bsetting\(/, start: /const setting = \(/ }],
  },
  {
    label: "Python",
    lang: "python",
    file: "python.py",
    calls: { target: "catalog\\.target", type: "catalog\\.type", capability: "catalog\\.capability", event: "catalog\\.event" },
    helpers: [{ uses: /\bsetting\(/, start: /def setting\(/ }],
  },
  {
    label: "Go",
    lang: "go",
    file: "go/main.go",
    calls: { target: "\\bTarget", type: "c\\.Type", capability: "\\bCapability", event: "\\bEvent" },
    helpers: [
      { uses: /\bsetting\(/, start: /setting := func\(/ },
      { uses: /\bofflineOnly\b/, start: /offlineOnly :=/ },
    ],
  },
  {
    label: "Rust",
    lang: "rust",
    file: "rust/src/main.rs",
    calls: { target: "\\.target", type: "catalog\\.r#type", capability: "\\.capability", event: "\\.event" },
    helpers: [
      { uses: /\bsetting\(/, start: /let setting = \|/ },
      { uses: /\boffline_only\(/, start: /let offline_only = / },
    ],
  },
];

const pklSections: Readonly<Record<EntryKind, string>> = { target: "targets", type: "types", capability: "capabilities", event: "events" };
const jsonSections: Readonly<Record<EntryKind, string>> = { target: "targets", type: "$defs", capability: "capabilities", event: "events" };

const escape = (text: string): string => text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const list = (value: string | readonly string[] | undefined): readonly string[] => (value === undefined ? [] : typeof value === "string" ? [value] : value);

const entriesOf = (selection: CatalogSelection): readonly Entry[] => {
  const entries = kinds.flatMap((kind) => list(selection[kind]).map((id) => ({ kind, id })));
  if (entries.length === 0) throw new Error("A catalog example needs a target, a type, a capability or an event.");
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

export const statementAt = (lines: readonly string[], first: number): readonly string[] => {
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
  return lines.slice(first, last + 1);
};

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
  new Error(`${catalogDirectory}/${file} has no ${entry.kind} "${entry.id}". Change the docs page, or the pattern in site/src/lib/catalog-examples.ts.`);

const helperBlocks = (lines: readonly string[], file: string, helpers: readonly Helper[], blocks: readonly string[]): string[] =>
  helpers
    .filter((helper) => blocks.some((block) => helper.uses.test(block)))
    .map((helper) => {
      const first = lines.findIndex((line) => helper.start.test(line));
      if (first < 0) throw new Error(`${catalogDirectory}/${file} has no line that matches ${helper.start}.`);
      return dedent(statementAt(lines, first));
    });

const read = async (repository: string, file: string): Promise<string> => readFile(join(repository, catalogDirectory, file), "utf8");

const codeExample = async (repository: string, source: Source, entries: readonly Entry[]): Promise<CatalogExample> => {
  const lines = (await read(repository, source.file)).split("\n");
  const blocks = entries.map((entry) => {
    const first = findCall(lines, source.calls[entry.kind], entry.id);
    if (first < 0) throw missing(source.file, entry);
    return dedent(statementAt(lines, first));
  });
  const code = [...helperBlocks(lines, source.file, source.helpers, blocks), ...blocks].join("\n\n");
  return { label: source.label, lang: source.lang, title: source.file, code };
};

const indent = (text: string): string =>
  text
    .split("\n")
    .map((line) => (line === "" ? line : `  ${line}`))
    .join("\n");

const pklExample = async (repository: string, entries: readonly Entry[]): Promise<CatalogExample> => {
  const file = "aircon.pkl";
  const lines = (await read(repository, file)).split("\n");
  const sections = kinds.flatMap((kind) => {
    const blocks = entries
      .filter((entry) => entry.kind === kind)
      .map((entry) => {
        const first = findPkl(lines, pklSections[kind], entry.id);
        if (first < 0) throw missing(file, entry);
        return dedent(statementAt(lines, first));
      });
    return blocks.length === 0 ? [] : [`${pklSections[kind]} {\n${indent(blocks.join("\n\n"))}\n}`];
  });
  const helpers = helperBlocks(lines, file, [{ uses: /\bsetting\(/, start: /^local function setting\(/ }], sections);
  return { label: "Pkl", lang: "pkl", title: file, code: [...helpers, ...sections].join("\n\n") };
};

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const jsonExample = async (repository: string, entries: readonly Entry[]): Promise<CatalogExample> => {
  const file = "aircon.acidcat.json";
  const parsed: unknown = JSON.parse(await read(repository, file));
  if (!isRecord(parsed)) throw new Error(`${catalogDirectory}/${file} is not a JSON object.`);
  const fragment: Record<string, Record<string, unknown>> = {};
  for (const kind of kinds) {
    for (const entry of entries.filter((candidate) => candidate.kind === kind)) {
      const section = parsed[jsonSections[kind]];
      const value = isRecord(section) ? section[entry.id] : undefined;
      if (value === undefined) throw missing(file, entry);
      fragment[jsonSections[kind]] = { ...fragment[jsonSections[kind]], [entry.id]: value };
    }
  }
  return { label: "JSON", lang: "json", title: file, code: JSON.stringify(fragment, null, 2) };
};

const defaultRepository = join(process.cwd(), "..");

export const catalogExamples = async (selection: CatalogSelection, repository = defaultRepository): Promise<CatalogExample[]> => {
  const entries = entriesOf(selection);
  return Promise.all([
    ...sources.map((source) => codeExample(repository, source, entries)),
    pklExample(repository, entries),
    jsonExample(repository, entries),
  ]);
};
