import { readFileSync } from "node:fs";
import path from "node:path";

import { isJsonObject, npmPackages, parseObject, root } from "./npm-packages.ts";

const PUBLISHED_DEPENDENCIES = ["dependencies", "optionalDependencies", "peerDependencies"] as const;

const problems: string[] = [];
const published = new Set<string>();
for (const npmPackage of npmPackages) {
  const file = path.join(npmPackage.directory, "package.json");
  const manifest = parseObject(readFileSync(path.join(root, file), "utf-8"), file);
  for (const member of PUBLISHED_DEPENDENCIES) {
    const dependencies = manifest[member];
    if (!isJsonObject(dependencies)) continue;
    for (const [name, version] of Object.entries(dependencies)) {
      if (typeof version !== "string" || !version.startsWith("workspace:") || published.has(name)) continue;
      problems.push(`${npmPackage.name} depends on ${name}, which npmPackages in scripts/npm-packages.ts does not list before it`);
    }
  }
  published.add(npmPackage.name);
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
