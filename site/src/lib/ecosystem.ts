import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Install =
  | { readonly kind: "node"; readonly packages: readonly string[]; readonly dev: boolean }
  | { readonly kind: "code"; readonly lang: string; readonly code: string };

export interface CatalogLanguage {
  readonly id: string;
  readonly label: string;
  readonly abbreviation: string;
  readonly directory: string;
  readonly packageName: string;
  readonly registry: string;
  readonly lang: string;
  readonly example: string;
  readonly install: readonly Install[];
  readonly write: readonly string[];
}

export interface Core {
  readonly id: string;
  readonly label: string;
  readonly directory: string;
  readonly packageName: string;
  readonly registry: string;
  readonly language: string;
  readonly lang: string;
  readonly readme: string;
  readonly example: string;
  readonly guide: string;
  readonly note: string;
  readonly requires: readonly string[];
  readonly install: readonly Install[];
  readonly webmcp: boolean;
}

export interface OwnCore {
  readonly id: string;
  readonly label: string;
  readonly note: string;
  readonly source: string;
  readonly steps: readonly string[];
  readonly conform: string;
}

export const syncKeys = { catalogLanguage: "catalog-language", core: "core" } as const;

export const catalogDirectory = "examples/aircon/catalog";

export const catalogLanguages: readonly CatalogLanguage[] = [
  {
    id: "typescript",
    label: "TypeScript",
    abbreviation: "ts",
    directory: "packages/catalog/typescript",
    packageName: "@acid-cat/catalog",
    registry: "npm",
    lang: "ts",
    example: `${catalogDirectory}/typescript.ts`,
    install: [{ kind: "node", packages: ["@acid-cat/catalog"], dev: true }],
    write: ["node typescript.ts > aircon.acidcat.json"],
  },
  {
    id: "python",
    label: "Python",
    abbreviation: "py",
    directory: "packages/catalog/python",
    packageName: "acid-cat-catalog",
    registry: "PyPI",
    lang: "python",
    example: `${catalogDirectory}/python.py`,
    install: [{ kind: "code", lang: "sh", code: "pip install acid-cat-catalog" }],
    write: ["python python.py > aircon.acidcat.json"],
  },
  {
    id: "go",
    label: "Go",
    abbreviation: "go",
    directory: "packages/catalog/go",
    packageName: "github.com/Hebilicious/acidcat/packages/catalog/go",
    registry: "Go modules",
    lang: "go",
    example: `${catalogDirectory}/go/main.go`,
    install: [{ kind: "code", lang: "sh", code: "go get github.com/Hebilicious/acidcat/packages/catalog/go" }],
    write: ["go -C go run . > aircon.acidcat.json"],
  },
  {
    id: "rust",
    label: "Rust",
    abbreviation: "rs",
    directory: "packages/catalog/rust",
    packageName: "acid-cat-catalog",
    registry: "crates.io",
    lang: "rust",
    example: `${catalogDirectory}/rust/src/main.rs`,
    install: [{ kind: "code", lang: "sh", code: "cargo add acid-cat-catalog serde_json" }],
    write: ["cargo run --quiet --manifest-path rust/Cargo.toml > aircon.acidcat.json"],
  },
  {
    id: "pkl",
    label: "Pkl",
    abbreviation: "pkl",
    directory: "packages/catalog/pkl",
    packageName: "package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog",
    registry: "Pkl packages",
    lang: "pkl",
    example: `${catalogDirectory}/aircon.pkl`,
    install: [{ kind: "code", lang: "pkl", code: 'amends "package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog@{version}#/Catalog.pkl"' }],
    write: ["pkl eval aircon.pkl --output-path aircon.acidcat.json", "acid-cat format --write aircon.acidcat.json"],
  },
];

export const cores: readonly Core[] = [
  {
    id: "core-ts",
    label: "TypeScript",
    directory: "packages/core-ts",
    packageName: "@acid-cat/core-ts",
    registry: "npm",
    language: "TypeScript",
    lang: "ts",
    readme: "packages/core-ts/README.md",
    example: "examples/aircon/core-ts",
    guide: "/docs/guides/serve-with-core-ts/",
    note: "Plain TypeScript. Capabilities return promises, and inputs use any Standard Schema library.",
    requires: ["Node.js 24 or later. Node.js runs the `.ts` files directly.", 'A project with `"type": "module"` in its `package.json`.'],
    install: [{ kind: "node", packages: ["@acid-cat/core-ts", "zod"], dev: false }],
    webmcp: true,
  },
  {
    id: "core-effect",
    label: "Effect",
    directory: "packages/core-effect",
    packageName: "@acid-cat/core-effect",
    registry: "npm",
    language: "TypeScript",
    lang: "ts",
    readme: "packages/core-effect/README.md",
    example: "examples/aircon/core-effect",
    guide: "/docs/guides/serve-with-core-effect/",
    note: "Effect. Capabilities are Effect programs, sessions are scopes, and services are layers.",
    requires: ["Node.js 24 or later. Node.js runs the `.ts` files directly.", 'A project with `"type": "module"` in its `package.json`.', "Effect version 4."],
    install: [{ kind: "node", packages: ["@acid-cat/core-effect", "effect", "@effect/platform-node"], dev: false }],
    webmcp: true,
  },
  {
    id: "core-rust",
    label: "Rust",
    directory: "packages/core-rust",
    packageName: "acid-cat-core",
    registry: "crates.io",
    language: "Rust",
    lang: "rust",
    readme: "packages/core-rust/README.md",
    example: "examples/aircon/core-rust",
    guide: "/docs/guides/serve-with-core-rust/",
    note: "Rust on Tokio. It serves the MCP, HTTP and CLI surfaces.",
    requires: ["Rust 1.85 or later, with Cargo."],
    install: [
      {
        kind: "code",
        lang: "sh",
        code: ["cargo new home", "cd home", "cargo add acid-cat-core schemars", "cargo add serde --features derive", "cargo add tokio --features macros,rt-multi-thread"].join("\n"),
      },
    ],
    webmcp: false,
  },
];

export const ownCore: OwnCore = {
  id: "your-own-core",
  label: "Your own core",
  note: "Any language. A core that follows the specification and passes acid-cat conform is an implementation.",
  source: "spec/conformance.md",
  steps: ["Follow the specification: spec/README.md", "Serve the conformance fixture: packages/cli/conformance/fixture.pkl", "Test each surface from outside:"],
  conform: ["npx @acid-cat/cli conform \\", "  --http http://localhost:8080 \\", "  --mcp http://localhost:8080/mcp \\", '  --cli "./your-program"'].join("\n"),
};

export const repositoryRoot = join(process.cwd(), "..");

export const githubBlob = "https://github.com/Hebilicious/acidcat/blob/main";

const isVersions = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

export const releasedVersion = async (directory: string, repository = repositoryRoot): Promise<string> => {
  const manifest: unknown = JSON.parse(await readFile(join(repository, ".release-please-manifest.json"), "utf8"));
  const version = isVersions(manifest) ? manifest[directory] : undefined;
  if (typeof version !== "string") throw new Error(`.release-please-manifest.json has no version for ${directory}. Add the package to release-please, or change site/src/lib/ecosystem.ts.`);
  return version;
};

export const installCode = async (install: Install & { readonly kind: "code" }, directory: string, repository = repositoryRoot): Promise<string> =>
  install.code.includes("{version}") ? install.code.replaceAll("{version}", await releasedVersion(directory, repository)) : install.code;

export function exampleFor<Entry extends { readonly id: string }, Example>(examples: Readonly<Partial<Record<string, Example>>>, entry: Entry, where: string): Example {
  const example = examples[entry.id];
  if (example === undefined) throw new Error(`${where} has no example for "${entry.id}", which site/src/lib/ecosystem.ts lists. Write one.`);
  return example;
}
