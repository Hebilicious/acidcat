/**
 * Reserve the name of a new npm package, so that the release workflow can publish all its versions.
 *
 * npm accepts a trusted publisher only for a package that exists. This script publishes an empty placeholder, version
 * `0.0.0`, which has no code. Then it adds the release workflow as the trusted publisher of the package. The release
 * workflow then publishes every real version, with provenance. Run it on a computer, one time for each new package,
 * before the first release of the package. npm asks for 2FA in the browser.
 *
 * Usage: node scripts/reserve-npm-package.ts <package>
 */
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { npmPackages } from "./npm-packages.ts";

const name = process.argv[2];
const npmPackage = npmPackages.find((candidate) => candidate.name === name);
if (npmPackage === undefined) {
  console.error(`Usage: node scripts/reserve-npm-package.ts <package>. The packages are: ${npmPackages.map((p) => p.name).join(", ")}.`);
  process.exit(1);
}

/** True if the package is on npm, at any version. */
const exists = () => {
  try {
    execFileSync("npm", ["view", npmPackage.name, "name"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
};

if (exists()) {
  console.log(`${npmPackage.name} is on npm already.`);
} else {
  const directory = mkdtempSync(path.join(tmpdir(), "acid-cat-reserve-"));
  try {
    const manifest = {
      name: npmPackage.name,
      version: "0.0.0",
      description: "A placeholder that reserves the name. The release workflow of Hebilicious/acidcat publishes the versions.",
      license: "MIT",
      repository: { type: "git", url: "git+https://github.com/Hebilicious/acidcat.git", directory: npmPackage.directory },
    };
    writeFileSync(path.join(directory, "package.json"), `${JSON.stringify(manifest, null, 2)}\n`);
    writeFileSync(path.join(directory, "README.md"), `# ${npmPackage.name}\n\nThis version is a placeholder. Install a later version.\n`);
    execFileSync("npm", ["publish", directory, "--access", "public"], { stdio: "inherit" });
  } finally {
    rmSync(directory, { recursive: true, force: true });
  }
}

execFileSync(
  "npm",
  ["trust", "github", npmPackage.name, "--repo", "Hebilicious/acidcat", "--file", "release-npm.yml", "--allow-publish", "--yes"],
  { stdio: "inherit" },
);
