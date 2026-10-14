/**
 * Check the npm packages as a user receives them. Build the packages first, with `moon run :build`.
 *
 * The check packs each package, and checks each tarball: the license is in it, no `workspace:` or `catalog:` version
 * is left, and each file that `exports` and `bin` name is in it. It then installs the tarballs into an empty project
 * outside the repository, and in that project:
 *
 * - runs `acid-cat check` on the air-conditioner catalog;
 * - copies the conformance test of each core, with its imports changed to the package names, type-checks it with
 *   strict options and the declarations of all libraries, and runs it. `acid-cat conform` then tests both cores
 *   through MCP, HTTP, CLI and WebMCP, all from the installed packages.
 *
 * Usage: node scripts/check-packages.ts [--keep]
 */
import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";

import { npmPackages, pack, packedManifest, root } from "./npm-packages.ts";

const keep = process.argv.includes("--keep");
const project = mkdtempSync(path.join(tmpdir(), "acid-cat-packages-"));
const problems: string[] = [];

const run = (command: string, args: readonly string[], cwd = project) =>
  execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });

/** The version of a dependency that the repository installs, so that the project tests the same versions. */
const installedVersion = (name: string, directory = "packages/core-effect") =>
  (JSON.parse(readFileSync(path.join(root, directory, "node_modules", name, "package.json"), "utf-8")) as { version: string })
    .version;

/** Every file path that `exports` or `bin` names, at any depth of conditions. */
const namedFiles = (value: unknown): string[] =>
  typeof value === "string" ? [value] : value && typeof value === "object" ? Object.values(value).flatMap(namedFiles) : [];

try {
  const tarballs = path.join(project, "tarballs");
  mkdirSync(tarballs);
  const packed = npmPackages.map((npmPackage) => pack(npmPackage, tarballs));

  for (const { name, tarball, files } of packed) {
    const manifest = packedManifest(tarball);
    if (!files.includes("LICENSE")) problems.push(`${name}: the tarball has no LICENSE`);
    if (/"(workspace|catalog):/.test(JSON.stringify(manifest))) problems.push(`${name}: a workspace: or catalog: version is left`);
    for (const file of namedFiles([manifest.exports, manifest.bin])) {
      if (!files.includes(path.posix.normalize(file))) problems.push(`${name}: ${file} is named but not in the tarball`);
    }
  }

  const tarballOf = Object.fromEntries(packed.map(({ name, tarball }) => [name, `file:${tarball}`]));
  writeFileSync(
    path.join(project, "package.json"),
    JSON.stringify(
      {
        name: "acid-cat-packages-check",
        private: true,
        type: "module",
        dependencies: {
          ...tarballOf,
          "@effect/platform-node": installedVersion("@effect/platform-node"),
          effect: installedVersion("effect"),
          zod: installedVersion("zod", "packages/core-ts"),
        },
        devDependencies: {
          "@types/node": installedVersion("@types/node"),
          typescript: installedVersion("typescript"),
        },
      },
      null,
      2,
    ),
  );
  // Each package depends on the others at their published versions, which may not be on npm yet.
  writeFileSync(
    path.join(project, "pnpm-workspace.yaml"),
    `overrides:\n${packed.map(({ name, tarball }) => `  "${name}": "file:${tarball}"\n`).join("")}`,
  );
  run("pnpm", ["install"]);

  run(path.join(project, "node_modules/.bin/acid-cat"), ["check", path.join(root, "examples/aircon.acidcat.json")]);

  for (const core of ["core-effect", "core-ts"]) {
    mkdirSync(path.join(project, core));
    for (const file of ["conform.test.ts", "fixture.ts", "fixture-cli.ts"]) {
      const text = readFileSync(path.join(root, "packages", core, "test", file), "utf-8")
        .replaceAll('"../src/index.ts"', `"@acid-cat/${core}"`)
        .replaceAll('"../src/node.ts"', `"@acid-cat/${core}/node"`);
      writeFileSync(path.join(project, core, file), text);
    }
  }

  const base = JSON.parse(readFileSync(path.join(root, "tsconfig.base.json"), "utf-8")) as {
    compilerOptions: Record<string, unknown>;
  };
  writeFileSync(
    path.join(project, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { ...base.compilerOptions, skipLibCheck: false }, include: ["core-effect", "core-ts"] }),
  );
  run(path.join(project, "node_modules/.bin/tsc"), ["-p", "."]);

  run(process.execPath, ["--test", "--test-timeout=60000", "core-effect/conform.test.ts", "core-ts/conform.test.ts"]);
} catch (error) {
  problems.push(error instanceof Error ? error.message : String(error));
} finally {
  if (keep) console.log(`The project is in ${project}`);
  else rmSync(project, { recursive: true, force: true });
}

if (problems.length > 0) {
  console.error(problems.join("\n"));
  process.exit(1);
}
console.log(`The ${npmPackages.length} npm packages install and pass their checks.`);
