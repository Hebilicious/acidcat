import assert from "node:assert/strict";
import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { test } from "node:test";
import { catalogLanguages, cores, ownCore, syncKeys } from "../src/lib/ecosystem.ts";

const repository = new URL("../../", import.meta.url).pathname;
const docs = new URL("../src/content/docs/docs/", import.meta.url).pathname;

const exists = async (path: string): Promise<boolean> =>
  stat(join(repository, path)).then(
    () => true,
    () => false,
  );

const directories = async (path: string): Promise<string[]> =>
  (await readdir(join(repository, path), { withFileTypes: true })).filter((entry) => entry.isDirectory()).map((entry) => entry.name);

const sorted = (values: readonly string[]): string[] => [...values].sort();

const firstMatch = (text: string, pattern: RegExp, file: string): string => {
  const value = pattern.exec(text)?.[1];
  if (value === undefined) throw new Error(`${file} does not match ${pattern}.`);
  return value;
};

const manifestName = async (directory: string): Promise<string> => {
  const files = await readdir(join(repository, directory));
  const read = (file: string): Promise<string> => readFile(join(repository, directory, file), "utf8");
  if (files.includes("package.json")) return firstMatch(await read("package.json"), /"name":\s*"([^"]+)"/, `${directory}/package.json`);
  if (files.includes("Cargo.toml")) return firstMatch(await read("Cargo.toml"), /^name = "([^"]+)"/m, `${directory}/Cargo.toml`);
  if (files.includes("pyproject.toml")) return firstMatch(await read("pyproject.toml"), /^name = "([^"]+)"/m, `${directory}/pyproject.toml`);
  if (files.includes("go.mod")) return firstMatch(await read("go.mod"), /^module (\S+)/m, `${directory}/go.mod`);
  if (files.includes("PklProject")) {
    const project = await read("PklProject");
    const name = firstMatch(project, /^\s*name = "([^"]+)"/m, `${directory}/PklProject`);
    return firstMatch(project, /^\s*baseUri = "([^"]+)"/m, `${directory}/PklProject`).replace("\\(name)", name);
  }
  throw new Error(`${directory} has no manifest that this test reads.`);
};

test("each Moon project under packages/catalog is a catalog language in the registry, and the reverse", async () => {
  const projects = [];
  for (const name of await directories("packages/catalog")) if (await exists(`packages/catalog/${name}/moon.yml`)) projects.push(`packages/catalog/${name}`);
  assert.deepEqual(sorted(catalogLanguages.map((language) => language.directory)), sorted(projects), "Change catalogLanguages in site/src/lib/ecosystem.ts.");
});

test("each packages/core-* directory is a core in the registry, and the reverse", async () => {
  const found = (await directories("packages")).filter((name) => name.startsWith("core-")).map((name) => `packages/${name}`);
  assert.deepEqual(sorted(cores.map((core) => core.directory)), sorted(found), "Change cores in site/src/lib/ecosystem.ts.");
});

test("each entry of the registry names its package, and points at files that exist", async () => {
  for (const entry of [...catalogLanguages, ...cores]) {
    assert.equal(await manifestName(entry.directory), entry.packageName, `${entry.id}: the package name`);
  }
  for (const language of catalogLanguages) assert.ok(await exists(language.example), `${language.id}: ${language.example} exists`);
  for (const core of cores) {
    assert.ok(await exists(core.readme), `${core.id}: ${core.readme} exists`);
    assert.ok(await exists(core.example), `${core.id}: ${core.example} exists`);
    assert.ok(await exists(`site/src/content/docs${core.guide.replace(/\/$/, "")}.mdx`), `${core.id}: the guide ${core.guide} exists`);
  }
  assert.equal(new Set([...catalogLanguages, ...cores, ownCore].map((entry) => entry.id)).size, catalogLanguages.length + cores.length + 1, "ids are unique");
});

const pages = async (directory: string, extension = /\.mdx?$/): Promise<string[]> => {
  const entries = await readdir(directory, { withFileTypes: true, recursive: true });
  return entries.filter((entry) => entry.isFile() && extension.test(entry.name)).map((entry) => join(entry.parentPath, entry.name));
};

const languageLabels = new Set(catalogLanguages.map((language) => language.label));
const coreLabels = new Set([...cores, ownCore].map((core) => core.label));
const registrySyncKeys = new Set<string>(Object.values(syncKeys));

const listsTheRegistry = (labels: readonly string[]): boolean =>
  labels.filter((label) => languageLabels.has(label)).length >= 2 || labels.filter((label) => coreLabels.has(label)).length >= 2;

const registryCount = /\b(?:two|three|four|five|six|seven|eight|nine|ten|both|\d+)\s+(?:\w+\s+)?(?:languages|cores)\b/gi;

const handWrittenLists = (text: string): string[] => {
  const problems: string[] = [];
  for (const match of text.matchAll(/<Tabs\b([^>]*)>([\s\S]*?)<\/Tabs>/g)) {
    const syncKey = /syncKey="([^"]+)"/.exec(match[1] ?? "")?.[1];
    const labels = [...(match[2] ?? "").matchAll(/<TabItem\s+label="([^"]+)"/g)].map((item) => item[1] ?? "");
    if (syncKey !== undefined && registrySyncKeys.has(syncKey)) problems.push(`<Tabs syncKey="${syncKey}"> written by hand`);
    else if (listsTheRegistry(labels)) problems.push(`<Tabs> with the tabs ${labels.join(", ")} written by hand`);
  }
  for (const table of text.match(/^\|.*\|\n\|\s*-.*\n(?:\|.*\|\n?)*/gm) ?? []) {
    const rows = table.trimEnd().split("\n").map((row) => row.split("|").map((cell) => cell.trim()));
    const header = rows[0] ?? [];
    const firstColumn = rows.slice(2).map((row) => row[1] ?? "");
    if (listsTheRegistry(header)) problems.push(`a table with the columns ${header.filter(Boolean).join(", ")}`);
    else if (listsTheRegistry(firstColumn)) problems.push(`a table with the rows ${firstColumn.join(", ")}`);
  }
  for (const match of text.matchAll(registryCount)) problems.push(`the count "${match[0]}"`);
  for (const match of text.matchAll(/\b[A-Z][\w-]*(?:,\s+[A-Z][\w-]*)+,?\s+and\s+[A-Z][\w-]*/g)) {
    if (listsTheRegistry(match[0].split(/,\s*|\s+and\s+/))) problems.push(`the list "${match[0]}"`);
  }
  for (const match of text.matchAll(/^\s*```\S*\s+title="([^"]*)"/gm)) {
    if (/\s/.test(match[1] ?? "")) problems.push(`the code block title "${match[1]}", which is not a file name`);
  }
  return problems;
};

test("no docs page writes by hand a list of languages or cores that the registry gives", async () => {
  const problems: string[] = [];
  for (const page of await pages(docs)) {
    for (const problem of handWrittenLists(await readFile(page, "utf8"))) problems.push(`${relative(repository, page)}: ${problem}`);
  }
  for (const page of await pages(new URL("../src/", import.meta.url).pathname, /\.astro$/)) {
    for (const match of (await readFile(page, "utf8")).matchAll(registryCount)) problems.push(`${relative(repository, page)}: the count "${match[0]}"`);
  }
  assert.deepEqual(problems, [], "Use EcosystemTabs, EcosystemInstall, EcosystemTable or CatalogExample from site/src/components/docs/, give each code block a file name as its title, and write no count or list of what the registry gives.");
});

test("the check finds hand-written tabs, tables and titles", () => {
  assert.equal(handWrittenLists('<Tabs syncKey="core">\n<TabItem label="Anything">x</TabItem>\n</Tabs>').length, 1);
  assert.equal(handWrittenLists('<Tabs>\n<TabItem label="Python">x</TabItem>\n<TabItem label="Go">y</TabItem>\n</Tabs>').length, 1);
  assert.equal(handWrittenLists('<Tabs syncKey="cli-or-code">\n<TabItem label="Command line">x</TabItem>\n<TabItem label="TypeScript">y</TabItem>\n</Tabs>').length, 0);
  assert.equal(handWrittenLists("| Step | Pkl | Go |\n| --- | --- | --- |\n| a | b | c |").length, 1);
  assert.equal(handWrittenLists("| Core | Package |\n| --- | --- |\n| TypeScript | a |\n| Effect | b |\n").length, 1);
  assert.equal(handWrittenLists("| Binding | Use |\n| --- | --- |\n| TypeScript | a |\n| WebMCP | b |\n").length, 0);
  assert.equal(handWrittenLists('```ts title="aircon.ts (part)"\nx\n```').length, 1);
  assert.equal(handWrittenLists('```ts title="aircon.ts"\nx\n```').length, 0);
  assert.equal(handWrittenLists("title: The catalog in five languages").length, 1);
  assert.equal(handWrittenLists("The two TypeScript cores serve it.").length, 1);
  assert.equal(handWrittenLists("Each TypeScript core serves it, in four protocol bindings.").length, 0);
  assert.equal(handWrittenLists("Written in Pkl, TypeScript, Python, Go and Rust.").length, 1);
  assert.equal(handWrittenLists("The CLI, MCP, HTTP and Rust bindings.").length, 0);
});
