import { execFileSync } from "node:child_process";
import { existsSync, statSync } from "node:fs";
import { basename, extname, join } from "node:path";
import { githubBlob, repositoryRoot } from "./ecosystem.ts";

export const examplesDirectory = "examples";

const lockFiles: ReadonlySet<string> = new Set(["Cargo.lock", "pnpm-lock.yaml", "package-lock.json", "go.sum", "uv.lock"]);

export interface FileKind {
  readonly icon: string;
  readonly lang: string;
}

const kindsByExtension: Readonly<Record<string, FileKind>> = {
  ".ts": { icon: "ts", lang: "typescript" },
  ".rs": { icon: "rs", lang: "rust" },
  ".go": { icon: "go", lang: "go" },
  ".py": { icon: "py", lang: "python" },
  ".pkl": { icon: "pkl", lang: "pkl" },
  ".json": { icon: "json", lang: "json" },
  ".toml": { icon: "toml", lang: "toml" },
  ".graphql": { icon: "gql", lang: "graphql" },
  ".md": { icon: "md", lang: "markdown" },
  ".yml": { icon: "yml", lang: "yaml" },
  ".yaml": { icon: "yml", lang: "yaml" },
  ".mod": { icon: "go", lang: "go" },
};

const plainText: FileKind = { icon: "txt", lang: "text" };

export const fileKind = (path: string): FileKind => kindsByExtension[extname(path)] ?? plainText;

export const fileLanguages: readonly string[] = [...new Set(Object.values(kindsByExtension).map((kind) => kind.lang))];

const listFiles = (directory: string, repository: string): string[] => {
  const output = execFileSync("git", ["ls-files", "--cached", "--others", "--exclude-standard", "-z", "--", directory], { cwd: repository, encoding: "utf8" });
  return output
    .split("\0")
    .filter((path) => path !== "" && !lockFiles.has(basename(path)) && existsSync(join(repository, path)))
    .map((path) => path.slice(directory.length + 1))
    .toSorted();
};

export const exampleNames = (repository = repositoryRoot): string[] => [...new Set(listFiles(examplesDirectory, repository).map((path) => path.split("/")[0] ?? ""))];

const cache = new Map<string, readonly string[]>();

export const exampleFiles = (example: string, repository = repositoryRoot): readonly string[] => {
  const key = `${repository}\0${example}`;
  const cached = cache.get(key);
  if (cached !== undefined) return cached;
  const directory = `${examplesDirectory}/${example}`;
  if (!existsSync(join(repository, directory)) || !statSync(join(repository, directory)).isDirectory()) {
    throw new Error(`${directory} does not exist. Change the docs page, or add the example.`);
  }
  const files = listFiles(directory, repository);
  cache.set(key, files);
  return files;
};

export const requireExampleFile = (example: string, file: string, where: string, repository = repositoryRoot): string => {
  if (!exampleFiles(example, repository).includes(file)) {
    throw new Error(`${where} points to ${examplesDirectory}/${example}/${file}, which does not exist or git ignores. Change the docs page.`);
  }
  return file;
};

export const sourcePath = (example: string, file: string): string => `${examplesDirectory}/${example}/${file}`;

export const githubUrl = (example: string, file: string): string => `${githubBlob}/${sourcePath(example, file)}`;

export const fragmentDirectory = (example: string): string => `/example-files/${example}/`;

export const fragmentUrl = (example: string, file: string): string => `${fragmentDirectory(example)}${file}.json`;

export interface FolderNode {
  readonly kind: "folder";
  readonly name: string;
  readonly path: string;
  readonly children: readonly TreeNode[];
}

export interface FileNode {
  readonly kind: "file";
  readonly name: string;
  readonly path: string;
  readonly icon: string;
}

export type TreeNode = FolderNode | FileNode;

interface MutableFolder {
  readonly folders: Map<string, MutableFolder>;
  readonly files: string[];
}

const toNodes = (folder: MutableFolder, prefix: string): TreeNode[] => [
  ...[...folder.folders]
    .toSorted(([a], [b]) => a.localeCompare(b))
    .map(([name, child]): FolderNode => ({ kind: "folder", name, path: `${prefix}${name}`, children: toNodes(child, `${prefix}${name}/`) })),
  ...folder.files.toSorted((a, b) => a.localeCompare(b)).map((name): FileNode => ({ kind: "file", name, path: `${prefix}${name}`, icon: fileKind(name).icon })),
];

export const fileTree = (files: readonly string[]): TreeNode[] => {
  const root: MutableFolder = { folders: new Map(), files: [] };
  for (const file of files) {
    const parts = file.split("/");
    const name = parts.pop() ?? file;
    let folder = root;
    for (const part of parts) {
      let child = folder.folders.get(part);
      if (child === undefined) {
        child = { folders: new Map(), files: [] };
        folder.folders.set(part, child);
      }
      folder = child;
    }
    folder.files.push(name);
  }
  return toNodes(root, "");
};
