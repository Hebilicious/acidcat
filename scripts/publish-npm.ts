// npm accepts a trusted publisher only for a package that exists.
import { execFileSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { parseArgs } from "node:util";

import { npmPackages, pack } from "./npm-packages.ts";

const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { "dry-run": { type: "boolean", default: false }, version: { type: "string" } },
});

const unknown = positionals.filter((name) => !npmPackages.some((npmPackage) => npmPackage.name === name));
if (unknown.length > 0) {
  console.error(`Unknown packages: ${unknown.join(", ")}. The packages are: ${npmPackages.map((p) => p.name).join(", ")}.`);
  process.exit(1);
}
const selected = positionals.length === 0 ? npmPackages : npmPackages.filter((p) => positionals.includes(p.name));

const isPublished = (name: string, version: string) => {
  try {
    const output = execFileSync("npm", ["view", `${name}@${version}`, "version"], {
      encoding: "utf-8",
      stdio: ["ignore", "pipe", "ignore"],
    });
    return output.trim() === version;
  } catch {
    return false; // npm view fails when the package does not exist yet.
  }
};

const exists = (name: string) => {
  try {
    execFileSync("npm", ["view", name, "name"], { stdio: ["ignore", "ignore", "ignore"] });
    return true;
  } catch {
    return false;
  }
};

const missing = selected.filter((npmPackage) => !exists(npmPackage.name));
if (missing.length > 0 && !values["dry-run"]) {
  console.error(
    [
      "These packages are not on npm, so they have no trusted publisher yet. Nothing was published.",
      ...missing.map((npmPackage) => `  ${npmPackage.name}`),
      "Reserve each name and add its trusted publisher, as .agents/skills/npm-release tells. Then run this workflow again.",
    ].join("\n"),
  );
  process.exit(1);
}

const destination = mkdtempSync(path.join(tmpdir(), "acid-cat-publish-"));
try {
  const packed = selected.map((npmPackage) => pack(npmPackage, destination));

  const wrong = packed.filter((p) => values.version !== undefined && p.version !== values.version);
  if (wrong.length > 0) {
    console.error(wrong.map((p) => `${p.name} has version ${p.version}, not ${values.version}`).join("\n"));
    process.exit(1);
  }

  for (const { name, version, tarball } of packed) {
    if (isPublished(name, version)) {
      console.log(`${name}@${version} is on npm already.`);
      continue;
    }
    const args = ["publish", tarball, "--access", "public", ...(version.includes("-") ? ["--tag", "next"] : [])];
    if (values["dry-run"]) args.push("--dry-run");
    execFileSync("npm", args, { stdio: "inherit" });
  }
} finally {
  rmSync(destination, { recursive: true, force: true });
}
