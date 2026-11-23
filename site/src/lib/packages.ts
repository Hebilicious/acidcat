import { readFile } from "node:fs/promises";
import { join } from "node:path";

export type Registry = "npm" | "crates.io" | "PyPI" | "Go" | "Pkl";

export interface PublishedPackage {
  readonly name: string;
  readonly registry: Registry;
  readonly directory: string;
  readonly version: string;
  readonly description: string;
  readonly install: string;
  readonly url: string;
  readonly latest: string;
  readonly kind: "tool" | "catalog" | "core" | "library";
}

const repository = "https://github.com/Hebilicious/acidcat";
const goModulePrefix = "github.com/Hebilicious/acidcat";
const pklPackage = "pkg.pkl-lang.org/github.com/Hebilicious/acidcat";

const isRecord = (value: unknown): value is Record<string, unknown> => typeof value === "object" && value !== null && !Array.isArray(value);

const readJson = async (path: string): Promise<Record<string, unknown>> => {
  const parsed: unknown = JSON.parse(await readFile(path, "utf8"));
  if (!isRecord(parsed)) throw new Error(`${path} is not a JSON object.`);
  return parsed;
};

const text = (value: unknown): string | undefined => (typeof value === "string" && value !== "" ? value : undefined);

const tomlField = async (path: string, field: string): Promise<string | undefined> => {
  const source = await readFile(path, "utf8");
  return new RegExp(`^${field}\\s*=\\s*"([^"]*)"`, "m").exec(source)?.[1];
};

const readmeUses = async (root: string): Promise<Map<string, string>> => {
  const source = await readFile(join(root, "packages/README.md"), "utf8");
  const uses = new Map<string, string>();
  for (const match of source.matchAll(/^\| [^|]+ \| \[`[^`]+`\]\(([^)]+)\) \| [^|]+ \| (.+) \|$/gm)) {
    const [, directory, use] = match;
    if (directory !== undefined && use !== undefined) uses.set(`packages/${directory}`, use.replace(/\[([^\]]+)\]\([^)]+\)/g, "$1").replace(/`/g, "").trim());
  }
  return uses;
};

const kindOf = (directory: string): PublishedPackage["kind"] => {
  if (directory.includes("/catalog/")) return "catalog";
  if (directory.includes("core-")) return "core";
  if (directory.endsWith("/cli")) return "tool";
  return "library";
};

const goEscape = (path: string): string => path.replace(/[A-Z]/g, (letter) => `!${letter.toLowerCase()}`);

export const readPublishedPackages = async (root: string): Promise<PublishedPackage[]> => {
  const config = await readJson(join(root, "release-please-config.json"));
  const manifest = await readJson(join(root, ".release-please-manifest.json"));
  const uses = await readmeUses(root);
  const entries = isRecord(config["packages"]) ? Object.entries(config["packages"]) : [];
  const packages = await Promise.all(
    entries.map(async ([directory, settings]): Promise<PublishedPackage | undefined> => {
      if (!isRecord(settings)) return undefined;
      const version = text(manifest[directory]) ?? "0.0.0";
      const use = uses.get(directory) ?? "";
      const releaseType = text(settings["release-type"]);
      const base = { directory, version, kind: kindOf(directory) };
      if (releaseType === "node") {
        const manifestJson = await readJson(join(root, directory, "package.json"));
        const name = text(manifestJson["name"]) ?? directory;
        return {
          ...base,
          name,
          registry: "npm",
          description: text(manifestJson["description"]) ?? use,
          install: `npm install ${name}`,
          url: `https://www.npmjs.com/package/${name}`,
          latest: `https://registry.npmjs.org/${name}/latest`,
        };
      }
      if (releaseType === "rust") {
        const cargo = join(root, directory, "Cargo.toml");
        const name = (await tomlField(cargo, "name")) ?? directory;
        return {
          ...base,
          name,
          registry: "crates.io",
          description: (await tomlField(cargo, "description")) ?? use,
          install: `cargo add ${name}`,
          url: `https://crates.io/crates/${name}`,
          latest: `https://crates.io/api/v1/crates/${name}`,
        };
      }
      if (releaseType === "python") {
        const pyproject = join(root, directory, "pyproject.toml");
        const name = (await tomlField(pyproject, "name")) ?? directory;
        return {
          ...base,
          name,
          registry: "PyPI",
          description: (await tomlField(pyproject, "description")) ?? use,
          install: `pip install ${name}`,
          url: `https://pypi.org/project/${name}/`,
          latest: `https://pypi.org/pypi/${name}/json`,
        };
      }
      if (releaseType === "go") {
        const name = `${goModulePrefix}/${directory}`;
        return {
          ...base,
          name,
          registry: "Go",
          description: use,
          install: `go get ${name}`,
          url: `https://pkg.go.dev/${name}`,
          latest: `https://proxy.golang.org/${goEscape(name)}/@latest`,
        };
      }
      const component = text(settings["component"]) ?? directory;
      return {
        ...base,
        name: `package://${pklPackage}/${component}`,
        registry: "Pkl",
        description: use,
        install: `amends "package://${pklPackage}/${component}@${version}#/Catalog.pkl"`,
        url: `${repository}/tree/main/${directory}`,
        latest: `https://api.github.com/repos/Hebilicious/acidcat/git/matching-refs/tags/${component}@`,
      };
    }),
  );
  return packages.filter((entry): entry is PublishedPackage => entry !== undefined);
};
