import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { exampleFiles, exampleNames, fragmentUrl } from "./example-files.ts";
import { highlightExampleFile } from "./example-highlight.ts";

/** Writes the highlighted HTML of each file of each example, which the code explorer loads when the reader selects the file. */
export const writeExampleFragments = async (dist: string, repositoryRoot: string): Promise<void> => {
  for (const example of exampleNames(repositoryRoot)) {
    await Promise.all(
      exampleFiles(example, repositoryRoot).map(async (file) => {
        const target = join(dist, fragmentUrl(example, file));
        await mkdir(dirname(target), { recursive: true });
        await writeFile(target, JSON.stringify({ html: await highlightExampleFile(example, file, repositoryRoot) }));
      }),
    );
  }
};
