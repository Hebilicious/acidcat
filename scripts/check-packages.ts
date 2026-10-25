/**
 * Check the npm packages as a user receives them. Build the packages first, with `moon run :build`.
 *
 * The check packs each package, and checks each tarball: the license is in it, no `workspace:` or `catalog:` version
 * is left, and each file that `exports` and `bin` name is in it. It then installs the tarballs into an empty project
 * outside the repository, and fails when a peer dependency is not met. In that project, the check:
 *
 * - runs `acid-cat check` on the air-conditioner catalog;
 * - bundles a web page that imports `Session`, `Handles` and `WebMcp` from `@acid-cat/core-effect`, once from the main
 *   entry point and once from the entry point of each module. The bundle must not contain `effect/cli` or `effect/ai`:
 *   a page pays only for the modules that it imports;
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
import { build } from "esbuild";

import { npmPackages, objectMember, pack, packedManifest, parseObject, root, stringMember } from "./npm-packages.ts";

const keep = process.argv.includes("--keep");
const project = mkdtempSync(path.join(tmpdir(), "acid-cat-packages-"));
const problems: string[] = [];

const run = (command: string, args: readonly string[], cwd = project) =>
  execFileSync(command, args, { cwd, stdio: ["ignore", "inherit", "inherit"] });

/** The version of a dependency that the repository installs, so that the project tests the same versions. */
const installedVersion = (name: string, directory = "packages/core-effect") => {
  const file = path.join(root, directory, "node_modules", name, "package.json");
  return stringMember(parseObject(readFileSync(file, "utf-8"), file), "version", file);
};

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
  // Each package depends on the others at their published versions, which may not be on npm yet. An unmet peer
  // dependency fails the install, because each user of the packages would see it as a warning.
  writeFileSync(
    path.join(project, "pnpm-workspace.yaml"),
    `strictPeerDependencies: true\noverrides:\n${packed.map(({ name, tarball }) => `  "${name}": "file:${tarball}"\n`).join("")}`,
  );
  run("pnpm", ["install"]);

  run(path.join(project, "node_modules/.bin/acid-cat"), ["check", path.join(root, "examples/aircon/catalog/aircon.acidcat.json")]);

  const pages = {
    "main entry point": `import { Session, Handles, WebMcp } from "@acid-cat/core-effect";`,
    "module entry points": [
      `import * as Session from "@acid-cat/core-effect/Session";`,
      `import * as Handles from "@acid-cat/core-effect/Handles";`,
      `import * as WebMcp from "@acid-cat/core-effect/WebMcp";`,
    ].join("\n"),
  };
  for (const [name, imports] of Object.entries(pages)) {
    const page = path.join(project, "page.ts");
    writeFileSync(page, `${imports}\nconsole.log(Session.make, Handles.make, WebMcp.install);\n`);
    const { metafile } = await build({
      entryPoints: [page],
      absWorkingDir: project,
      bundle: true,
      write: false,
      minify: true,
      platform: "browser",
      format: "esm",
      metafile: true,
      logLevel: "error",
    });
    const bundled = Object.values(metafile.outputs).flatMap((output) =>
      Object.entries(output.inputs).filter(([, input]) => input.bytesInOutput > 0).map(([file]) => file),
    );
    for (const module of ["cli", "ai"]) {
      if (bundled.some((file) => file.includes(`/effect/dist/${module}/`))) {
        problems.push(`@acid-cat/core-effect: a web page that imports from the ${name} bundles effect/${module}`);
      }
    }
  }

  for (const core of ["core-effect", "core-ts"]) {
    mkdirSync(path.join(project, core));
    for (const file of ["conform.test.ts", "fixture.ts", "fixture-cli.ts"]) {
      const text = readFileSync(path.join(root, "packages", core, "test", file), "utf-8")
        .replaceAll('"../src/index.ts"', `"@acid-cat/${core}"`)
        .replaceAll('"../src/node.ts"', `"@acid-cat/${core}/node"`);
      writeFileSync(path.join(project, core, file), text);
    }
  }

  const base = parseObject(readFileSync(path.join(root, "tsconfig.base.json"), "utf-8"), "tsconfig.base.json");
  const compilerOptions = objectMember(base, "compilerOptions", "tsconfig.base.json");
  writeFileSync(
    path.join(project, "tsconfig.json"),
    JSON.stringify({ compilerOptions: { ...compilerOptions, skipLibCheck: false }, include: ["core-effect", "core-ts"] }),
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
