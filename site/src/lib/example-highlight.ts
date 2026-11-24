import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { repositoryRoot } from "./ecosystem.ts";
import { fileKind, sourcePath } from "./example-files.ts";
import { highlight } from "./highlight.ts";

export const highlightExampleFile = async (example: string, file: string, repository = repositoryRoot): Promise<string> => {
  const code = await readFile(join(repository, sourcePath(example, file)), "utf8");
  return highlight(code.replace(/\n$/, ""), fileKind(file).lang);
};
