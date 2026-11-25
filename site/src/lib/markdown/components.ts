import { existsSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { packageManagers } from "../package-managers.ts";
import { catalogExamples } from "../catalog-examples.ts";
import type { CatalogSelection } from "../catalog-examples.ts";
import { catalogLanguages, cores, exampleFor, githubBlob, installCode, ownCore, syncKeys } from "../ecosystem.ts";
import type { Install } from "../ecosystem.ts";
import { exampleFiles, fileTree, fragmentDirectory, githubUrl, requireExampleFile, sourcePath } from "../example-files.ts";
import type { TreeNode } from "../example-files.ts";
import { explorerSource } from "../example-highlight.ts";
import { inlineCode } from "../inline-code.ts";
import { pickFence } from "../markdown-fences.ts";
import { catalogFlowSvg } from "../spec-diagrams.ts";

/**
 * The components of the docs that read the repository. Each one is written in a page like a Vue component,
 * for example `<CatalogExample capability="aircon.power.set" />`, and becomes Markdown before the page renders,
 * so a missing file fails the build. Each one renders static HTML. The theme gives the tabs and the code explorer their
 * behavior in the browser, so the content of a page stays static.
 */

type Attributes = Readonly<Record<string, string | true>>;

export interface ComponentContext {
  readonly page: string;
  readonly repositoryRoot: string;
  readonly content: string;
  /** Counts the tab groups of the page, so that each tab and each panel has its own id. */
  readonly ids: { next: number };
}

type Component = (attributes: Attributes, inner: string | undefined, context: ComponentContext) => string | Promise<string>;

const role = (name: string): string => `data-role="${name}" role="${name}"`;

const escapeHtml = (text: string): string => text.replaceAll("&", "&amp;").replaceAll("<", "&lt;").replaceAll(">", "&gt;").replaceAll('"', "&quot;");

const text = (attributes: Attributes, name: string): string | undefined => {
  const value = attributes[name];
  return typeof value === "string" ? value : undefined;
};

const required = (attributes: Attributes, name: string, component: string, context: ComponentContext): string => {
  const value = text(attributes, name);
  if (value === undefined) throw new Error(`${context.page}: <${component}> needs the attribute ${name}.`);
  return value;
};

/** A fenced code block whose fence is longer than any run of backticks in the code. */
export const fence = (code: string, language: string, title?: string): string => {
  const longest = Math.max(2, ...Array.from(code.matchAll(/`+/g), (match) => match[0].length));
  const marks = "`".repeat(longest + 1);
  return `${marks}${language}${title === undefined ? "" : ` title="${title}"`}\n${code}\n${marks}`;
};

interface Tab {
  readonly label: string;
  readonly body: string;
}

const tabs = (syncKey: string | undefined, panels: readonly Tab[], context: ComponentContext): string => {
  const group = context.ids.next++;
  const id = (kind: string, index: number) => `tabs-${group}-${kind}-${index}`;
  const items = panels
    .map(
      (panel, index) =>
        `<li class="tab" ${role("presentation")}><a ${role("tab")} href="#${id("panel", index)}" id="${id("tab", index)}" aria-selected="${index === 0}" tabindex="${index === 0 ? 0 : -1}">${escapeHtml(panel.label)}</a></li>`,
    )
    .join("");
  return [
    `<div class="tabs"${syncKey === undefined ? "" : ` data-sync-key="${syncKey}"`}>`,
    `<div class="tablist-wrapper"><ul ${role("tablist")}>${items}</ul></div>`,
    "",
    ...panels.map((panel, index) => `<div ${role("tabpanel")} id="${id("panel", index)}" aria-labelledby="${id("tab", index)}"${index === 0 ? "" : " hidden"}>\n\n${panel.body}\n\n</div>\n`),
    "</div>",
  ].join("\n");
};

const tabItems = (inner: string | undefined, attribute: "label" | "for"): Map<string, string> =>
  new Map(Array.from((inner ?? "").matchAll(new RegExp(`<TabItem ${attribute}="([^"]+)">([\\s\\S]*?)</TabItem>`, "g")), (match) => [match[1] ?? "", (match[2] ?? "").trim()]));

const list = (value: string | undefined): string | string[] | undefined => {
  if (value === undefined) return undefined;
  const items = value.split(",").map((item) => item.trim());
  return items.length === 1 ? items[0] : items;
};

const packageInstall = (packages: readonly string[], dev: boolean, run: string | undefined, context: ComponentContext): string =>
  tabs(
    "package-manager",
    packageManagers.map((manager) => {
      const install = [manager.add, ...(dev ? [manager.devFlag] : []), ...packages].join(" ");
      return { label: manager.name, body: fence(run === undefined ? install : `${install}\n${manager.exec} ${run}`, "sh") };
    }),
    context,
  );

const fileLink = (file: string): string => `<a href="#file=${escapeHtml(file)}" data-file-link><code>${escapeHtml(file)}</code></a>`;

const ecosystemOf = (attributes: Attributes, component: string, context: ComponentContext): "catalog-languages" | "cores" => {
  const of = required(attributes, "of", component, context);
  if (of !== "catalog-languages" && of !== "cores") throw new Error(`${context.page}: <${component} of="${of}"> must be of="catalog-languages" or of="cores".`);
  return of;
};

const treeItems = (nodes: readonly TreeNode[], selected: string, depth: number): string =>
  nodes
    .map((node) => {
      const row = (inner: string) => `<span class="row" style="--depth: ${depth}">${inner}<span class="name">${escapeHtml(node.name)}</span></span>`;
      if (node.kind === "folder") {
        const open = selected.startsWith(`${node.path}/`);
        const folder = '<svg class="folder" viewBox="0 0 16 16" aria-hidden="true"><path d="M1.5 3.5h4.5l1.5 1.5h7v8h-13z" /></svg>';
        return `<li ${role("treeitem")} aria-expanded="${open}" data-path="${escapeHtml(node.path)}" tabindex="-1">${row(folder)}<ul ${role("group")}>${treeItems(node.children, selected, depth + 1)}</ul></li>`;
      }
      const current = node.path === selected;
      const icon = `<span class="icon" data-icon="${node.icon}" aria-hidden="true">${node.icon}</span>`;
      return `<li ${role("treeitem")} aria-selected="${current}" data-path="${escapeHtml(node.path)}" data-file tabindex="${current ? 0 : -1}">${row(icon)}</li>`;
    })
    .join("");

const icon = {
  tree: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 3h12M2 8h12M2 13h12M6 3v10" /></svg>',
  external: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M6 3H3v10h10v-3M9 2h5v5M14 2 7 9" /></svg>',
  fullscreen: '<svg viewBox="0 0 16 16" aria-hidden="true"><path d="M2 6V2h4M10 2h4v4M14 10v4h-4M6 14H2v-4" /></svg>',
};

const codeExplorer: Component = (attributes, _inner, context) => {
  const example = text(attributes, "example") ?? "aircon";
  const selected = requireExampleFile(example, required(attributes, "open", "CodeExplorer", context), context.page, context.repositoryRoot);
  const id = `explorer-${example}`;
  const prefix = sourcePath(example, "");
  const name = escapeHtml(prefix.slice(0, -1));
  const figure = [
    `<figure class="explorer not-content" data-explorer data-tree="auto" data-open="${escapeHtml(selected)}" data-fragments="${fragmentDirectory(example)}" data-github="${githubUrl(example, "")}" data-prefix="${prefix}">`,
    '<div class="bar">',
    `<button type="button" class="tool" data-tree-toggle aria-controls="${id}-files" aria-expanded="true">${icon.tree}<span class="sr-only">Show or hide the files</span></button>`,
    '<span class="tab" aria-current="true">Code explorer</span>',
    `<a class="tab github" data-github-link href="${githubUrl(example, selected)}" target="_blank" rel="noopener noreferrer">Open on GitHub ${icon.external}</a>`,
    `<button type="button" class="tool fullscreen" data-fullscreen aria-pressed="false">${icon.fullscreen}<span class="sr-only">Full screen</span></button>`,
    "</div>",
    '<div class="body">',
    `<nav class="files" id="${id}-files" aria-label="Files of ${name}"><ul ${role("tree")} aria-label="${name}" data-tree>${treeItems(fileTree(exampleFiles(example, context.repositoryRoot)), selected, 0)}</ul></nav>`,
    `<section class="code" aria-label="Source"><p class="path" data-current-path>${escapeHtml(sourcePath(example, selected))}</p>${explorerSource(example, selected)}</section>`,
    "</div>",
    "</figure>",
  ].join("");
  return figure;
};

const installSteps = (install: readonly Install[], directory: string, context: ComponentContext): Promise<string[]> =>
  Promise.all(install.map(async (step) => (step.kind === "node" ? packageInstall(step.packages, step.dev, undefined, context) : fence(await installCode(step, directory, context.repositoryRoot), step.lang))));

const components: Readonly<Record<string, Component>> = {
  CardGrid: (_attributes, inner) => `<div class="card-grid">\n\n${(inner ?? "").trim()}\n\n</div>`,

  CatalogExample: async (attributes, _inner, context) => {
    const selection: CatalogSelection = {
      target: list(text(attributes, "target")),
      type: list(text(attributes, "type")),
      capability: list(text(attributes, "capability")),
      event: list(text(attributes, "event")),
      header: attributes["header"] === true,
    };
    const examples = await catalogExamples(selection);
    return tabs(
      syncKeys.catalogLanguage,
      examples.map((example) => ({ label: example.label, body: fence(example.code, example.lang, example.title) })),
      context,
    );
  },

  CatalogFlow: () => catalogFlowSvg.replace(/\n\s*/g, " "),

  CatalogSources: (_attributes, _inner, context) => {
    const prefix = "examples/aircon/";
    const rows = catalogLanguages.map((language) => {
      if (!language.example.startsWith(prefix)) throw new Error(`site/src/lib/ecosystem.ts gives ${language.example} for ${language.label}, which is not in ${prefix}.`);
      const file = requireExampleFile("aircon", language.example.slice(prefix.length), context.page, context.repositoryRoot);
      return `<tr><td>${language.label}</td><td>${fileLink(file)}</td><td>${language.write.map((command) => `<code>${escapeHtml(command)}</code>`).join("")}</td></tr>`;
    });
    return `<table><thead><tr><th>Language</th><th>Source</th><th>Write the JSON, from <code>catalog/</code></th></tr></thead><tbody>${rows.join("")}</tbody></table>`;
  },

  CatalogSteps: () => {
    const steps = ["Start", "Declare a target", "Share a type", "Declare a capability", "Declare an event", "Check the rules", "Render canonical JSON"] as const;
    type Calls = Readonly<Record<(typeof steps)[number], string>>;
    const calls: Readonly<Partial<Record<string, Calls>>> = {
      pkl: {
        Start: '`amends "Catalog.pkl"`',
        "Declare a target": "`targets { … }`",
        "Share a type": '`types { … }`, then `module.ref("Name")`',
        "Declare a capability": "`capabilities { … }`",
        "Declare an event": "`events { … }`",
        "Check the rules": "While you write",
        "Render canonical JSON": "`pkl eval`, then `acid-cat format`",
      },
      typescript: {
        Start: "`new Catalog({ title })`",
        "Declare a target": "`.target(name, {…})`",
        "Share a type": "`c.type(name, {…})`",
        "Declare a capability": "`.capability(id, {…})`",
        "Declare an event": "`.event(id, {…})`",
        "Check the rules": "`.validate()`",
        "Render canonical JSON": "`.render()`",
      },
      python: {
        Start: "`Catalog(title=…)`",
        "Declare a target": "`.target(name, …)`",
        "Share a type": "`c.type(name, {…})`",
        "Declare a capability": "`.capability(id, …)`",
        "Declare an event": "`.event(id, …)`",
        "Check the rules": "`.validate()`",
        "Render canonical JSON": "`.render()`",
      },
      go: {
        Start: "`catalog.New(title, description)`",
        "Declare a target": "`.Target(name, …)`",
        "Share a type": "`c.Type(name, …)`",
        "Declare a capability": "`.Capability(id, …)`",
        "Declare an event": "`.Event(id, …)`",
        "Check the rules": "`.Validate()`",
        "Render canonical JSON": "`.Render()`",
      },
      rust: {
        Start: "`Catalog::new(title, description)`",
        "Declare a target": "`.target(name, …)`",
        "Share a type": "`c.r#type(name, json!({…}))`",
        "Declare a capability": "`.capability(id, …)`",
        "Declare an event": "`.event(id, …)`",
        "Check the rules": "`.validate()`",
        "Render canonical JSON": "`.render()`",
      },
    };
    const columns = catalogLanguages.map((language) => ({ label: language.label, calls: exampleFor(calls, language, "site/src/lib/markdown/components.ts (CatalogSteps)") }));
    const head = `<tr><th>Step</th>${columns.map((column) => `<th>${column.label}</th>`).join("")}</tr>`;
    const rows = steps.map((step) => `<tr><td>${step}</td>${columns.map((column) => `<td>${inlineCode(column.calls[step])}</td>`).join("")}</tr>`);
    return `<table><thead>${head}</thead><tbody>${rows.join("")}</tbody></table>`;
  },

  CatalogWrite: (_attributes, _inner, context) =>
    tabs(
      syncKeys.catalogLanguage,
      catalogLanguages.map((language) => ({ label: language.label, body: fence(language.write.join("\n"), "sh") })),
      context,
    ),

  CodeExplorer: codeExplorer,

  CoreExamples: (_attributes, _inner, context) =>
    cores
      .map((core) => {
        const page = `examples/${core.id}.md`;
        if (!existsSync(join(context.content, page))) throw new Error(`site/content/${page} does not exist. Each core in site/src/lib/ecosystem.ts has an example page.`);
        return `- [The air conditioner on the ${core.label} core](/examples/${core.id}/): ${core.note}`;
      })
      .join("\n"),

  CoreGuides: () => cores.map((core, index) => `${index === 0 ? "" : index === cores.length - 1 ? " or " : ", "}[Serve with the ${core.label} core](${core.guide})`).join(""),

  EcosystemInstall: async (attributes, _inner, context) => {
    const of = ecosystemOf(attributes, "EcosystemInstall", context);
    const entries =
      of === "catalog-languages"
        ? catalogLanguages.map((language) => ({ label: language.label, packageName: language.packageName, registry: language.registry, requires: [], install: language.install, directory: language.directory }))
        : cores.map((core) => ({ label: core.label, packageName: core.packageName, registry: core.registry, requires: core.requires, install: core.install, directory: core.directory }));
    const panels = await Promise.all(
      entries.map(async (entry) => ({
        label: entry.label,
        body: [
          ...(entry.requires.length > 0 ? [entry.requires.map((requirement) => `- ${requirement}`).join("\n")] : []),
          ...(await installSteps(entry.install, entry.directory, context)),
          `The package is \`${entry.packageName}\` on ${entry.registry}.`,
        ].join("\n\n"),
      })),
    );
    return tabs(of === "catalog-languages" ? syncKeys.catalogLanguage : syncKeys.core, panels, context);
  },

  EcosystemTable: (attributes, _inner, context) => {
    const of = ecosystemOf(attributes, "EcosystemTable", context);
    const rows =
      of === "catalog-languages"
        ? catalogLanguages.map((language) => ({ name: language.label, packageName: language.packageName, registry: language.registry, note: undefined, example: language.example }))
        : cores.map((core) => ({ name: core.label, packageName: core.packageName, registry: core.registry, note: core.note, example: core.example }));
    const tree = (path: string): string => `${githubBlob.replace("/blob/", "/tree/")}/${path}`;
    const head = `<tr><th>${of === "catalog-languages" ? "Language" : "Core"}</th><th>Package</th>${of === "cores" ? "<th>Style</th>" : ""}<th>Example</th></tr>`;
    const body = rows.map(
      (row) =>
        `<tr><td>${row.name}</td><td>${row.registry} <code>${escapeHtml(row.packageName)}</code></td>${row.note === undefined ? "" : `<td>${escapeHtml(row.note)}</td>`}<td><a href="${tree(row.example)}" target="_blank" rel="noopener noreferrer"><code>${row.example}</code></a></td></tr>`,
    );
    return `<table><thead>${head}</thead><tbody>${body.join("")}</tbody></table>`;
  },

  EcosystemTabs: (attributes, inner, context) => {
    const of = ecosystemOf(attributes, "EcosystemTabs", context);
    const entries = of === "catalog-languages" ? catalogLanguages : [...cores, ...(attributes["own"] === true ? [ownCore] : [])];
    const written = tabItems(inner, "for");
    const panels = entries.map((entry) => {
      const body = written.get(entry.id);
      if (body === undefined) throw new Error(`${context.page} has no tab for ${entry.label} ("${entry.id}"), which site/src/lib/ecosystem.ts lists. Add <TabItem for="${entry.id}"> inside <EcosystemTabs of="${of}">.`);
      written.delete(entry.id);
      return { label: entry.label, body };
    });
    const [extra] = written.keys();
    if (extra !== undefined) throw new Error(`${context.page} has a tab for "${extra}", which site/src/lib/ecosystem.ts does not list in ${of}.`);
    const labelled = [...tabItems(inner, "label")].map(([label, body]) => ({ label, body }));
    return tabs(of === "catalog-languages" ? syncKeys.catalogLanguage : syncKeys.core, [...panels, ...labelled], context);
  },

  ExampleBlock: async (attributes, _inner, context) => {
    const example = text(attributes, "example") ?? "aircon";
    const readme = sourcePath(example, "README.md");
    const query = { section: required(attributes, "section", "ExampleBlock", context), language: text(attributes, "language"), match: text(attributes, "match") };
    const picked = pickFence(await readFile(join(context.repositoryRoot, readme), "utf8"), query, `${readme} (for ${context.page})`);
    return fence(picked.code, picked.language);
  },

  FileLink: (attributes, _inner, context) => {
    const example = text(attributes, "example") ?? "aircon";
    return fileLink(requireExampleFile(example, required(attributes, "file", "FileLink", context), context.page, context.repositoryRoot));
  },

  OwnCore: () =>
    [
      "A core in any other language is an implementation when it follows the specification and passes `acid-cat conform`.",
      "1. Follow the [specification](/spec/).\n2. Serve the [conformance fixture](/spec/conformance/#the-conformance-fixture), `packages/cli/conformance/fixture.pkl`, through each surface of your core.\n3. Test each surface from outside with `acid-cat conform`:",
      fence(ownCore.conform, "sh"),
      "[Test an implementation with acid-cat conform](/docs/guides/test-with-conform/) gives every flag.",
    ].join("\n\n"),

  PackageInstall: (attributes, _inner, context) =>
    packageInstall(required(attributes, "packages", "PackageInstall", context).split(/\s+/), attributes["dev"] === true, text(attributes, "run"), context),

  PackageRun: (attributes, _inner, context) => {
    const command = required(attributes, "command", "PackageRun", context);
    const before = text(attributes, "before");
    return tabs(
      "package-manager",
      packageManagers.map((manager) => ({ label: manager.name, body: fence([...(before === undefined ? [] : [before]), `${manager.exec} ${command}`].join("\n"), "sh") })),
      context,
    );
  },

  LinkCard: (attributes, _inner, context) => {
    const title = escapeHtml(required(attributes, "title", "LinkCard", context));
    const description = text(attributes, "description");
    const arrow = '<svg aria-hidden="true" class="icon" width="24" height="24" viewBox="0 0 24 24" fill="currentColor"><path d="M17.92 11.62a1.001 1.001 0 0 0-.21-.33l-5-5a1.003 1.003 0 1 0-1.42 1.42l3.3 3.29H7a1 1 0 0 0 0 2h7.59l-3.3 3.29a1.002 1.002 0 0 0 .325 1.639 1 1 0 0 0 1.095-.219l5-5a1 1 0 0 0 .21-.33 1 1 0 0 0 0-.76Z"/></svg>';
    return `<div class="link-card"><span class="stack"><a href="${escapeHtml(required(attributes, "href", "LinkCard", context))}"><span class="title">${title}</span></a>${description === undefined ? "" : `<span class="description">${escapeHtml(description)}</span>`}</span>${arrow}</div>`;
  },

  Steps: (_attributes, inner) => `<div class="steps">\n\n${(inner ?? "").trim()}\n\n</div>`,

  Tabs: (attributes, inner, context) =>
    tabs(
      text(attributes, "sync-key"),
      [...tabItems(inner, "label")].map(([label, body]) => ({ label, body })),
      context,
    ),
};

const asideIcons: Readonly<Record<string, string>> = {
  note: '<path d="M12 8v4m0 4h.01M21 12a9 9 0 1 1-18 0 9 9 0 0 1 18 0Z"/>',
  tip: '<path d="M9 18h6m-5 3h4M12 3a6 6 0 0 0-3.5 10.9c.6.5 1 1.2 1 2.1h5c0-.9.4-1.6 1-2.1A6 6 0 0 0 12 3Z"/>',
  caution: '<path d="M12 9v4m0 4h.01M10.3 3.9 1.8 18a2 2 0 0 0 1.7 3h17a2 2 0 0 0 1.7-3L13.7 3.9a2 2 0 0 0-3.4 0Z"/>',
  danger: '<path d="M7.9 2h8.2L22 7.9v8.2L16.1 22H7.9L2 16.1V7.9ZM12 8v4m0 4h.01"/>',
};

const asideTitles: Readonly<Record<string, string>> = { note: "Note", tip: "Tip", caution: "Caution", danger: "Danger" };

const asideOpen = (type: string, title: string | undefined): string => {
  const label = escapeHtml(title ?? asideTitles[type] ?? type);
  return `<aside aria-label="${label}" class="aside aside-${type}"><p class="aside-title" aria-hidden="true"><svg viewBox="0 0 24 24">${asideIcons[type] ?? ""}</svg>${label}</p><div class="aside-content">\n\n`;
};

/** The ranges of the source that fenced code blocks hold. A component inside one is text. */
const fencedRanges = (source: string): [number, number][] => {
  const ranges: [number, number][] = [];
  const pattern = /^( {0,3})(`{3,}|~{3,})[^\n]*\n[\s\S]*?^\1\2[`~]*[ \t]*$/gm;
  for (const match of source.matchAll(pattern)) ranges.push([match.index, match.index + match[0].length]);
  return ranges;
};

const attributesOf = (source: string): Attributes =>
  Object.fromEntries(Array.from(source.matchAll(/([A-Za-z][\w-]*)(?:="([^"]*)")?/g), (match) => [match[1] ?? "", match[2] ?? true]));

const componentPattern = new RegExp(`<(${Object.keys(components).join("|")})\\b([^>]*?)(/?)>`, "g");

const asides = (source: string): string => {
  const ranges = fencedRanges(source);
  const inFence = (index: number) => ranges.some(([start, end]) => index >= start && index < end);
  return source.replace(/^:::[ \t]*(note|tip|caution|danger)(?:[ \t]+(.+?))?[ \t]*$|^:::[ \t]*$/gm, (line: string, type: string | undefined, title: string | undefined, offset: number) => {
    if (inFence(offset)) return line;
    return type === undefined ? "\n\n</div></aside>\n" : asideOpen(type, title);
  });
};

const expandOnce = async (source: string, context: ComponentContext): Promise<string | undefined> => {
  const ranges = fencedRanges(source);
  for (const match of [...source.matchAll(componentPattern)].reverse()) {
    if (ranges.some(([start, end]) => match.index >= start && match.index < end)) continue;
    const [tag, name = "", attributeSource = "", selfClosing] = match;
    const component = components[name];
    if (component === undefined) continue;
    let end = match.index + tag.length;
    let inner: string | undefined;
    if (selfClosing !== "/") {
      const close = source.indexOf(`</${name}>`, end);
      if (close === -1) throw new Error(`${context.page}: <${name}> has no closing tag.`);
      inner = source.slice(end, close);
      end = close + name.length + 3;
    }
    const lineStart = source.lastIndexOf("\n", match.index - 1) + 1;
    const indent = /^[ \t]*$/.test(source.slice(lineStart, match.index)) ? source.slice(lineStart, match.index) : "";
    const output = (await component(attributesOf(attributeSource), inner, context)).replaceAll("\n", `\n${indent}`).replaceAll(/\n[ \t]+\n/g, "\n\n");
    return source.slice(0, match.index) + output + source.slice(end);
  }
  return undefined;
};

/** Replaces each component of the docs in the Markdown of a page, and each aside container, with what it renders. */
export const expandComponents = async (source: string, page: Omit<ComponentContext, "ids">): Promise<string> => {
  const context = { ...page, ids: { next: 0 } };
  let current = asides(source);
  for (let next = await expandOnce(current, context); next !== undefined; next = await expandOnce(current, context)) current = next;
  return current;
};
