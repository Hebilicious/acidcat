/**
 * The packages that this repository publishes to npm, and how to pack them.
 *
 * The list is in publishing order: each package comes after the packages that it depends on.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");

export const npmPackages = [
  { name: "@acid-cat/spec-ts", directory: "packages/spec-ts" },
  { name: "@acid-cat/catalog", directory: "packages/catalog/typescript" },
  { name: "@acid-cat/cli", directory: "packages/cli" },
  { name: "@acid-cat/core-effect", directory: "packages/core-effect" },
  { name: "@acid-cat/core-ts", directory: "packages/core-ts" },
] as const;

export type NpmPackage = (typeof npmPackages)[number];

export interface Packed {
  readonly name: string;
  readonly version: string;
  /** The absolute path of the tarball. */
  readonly tarball: string;
  /** The paths in the tarball, relative to the package. */
  readonly files: readonly string[];
}

/**
 * Pack one package into `destination` with pnpm. pnpm applies `publishConfig` and replaces the `workspace:` and
 * `catalog:` versions, so the tarball is exactly what npm receives. Build the package first.
 */
export const pack = (npmPackage: NpmPackage, destination: string): Packed => {
  const output = execFileSync("pnpm", ["pack", "--json", "--pack-destination", destination], {
    cwd: path.join(root, npmPackage.directory),
    encoding: "utf-8",
  });
  const packed = JSON.parse(output) as { name: string; version: string; filename: string; files: { path: string }[] };
  return {
    name: packed.name,
    version: packed.version,
    tarball: path.resolve(destination, path.basename(packed.filename)),
    files: packed.files.map((file) => file.path),
  };
};

/** The manifest inside a tarball. */
export const packedManifest = (tarball: string): Record<string, unknown> =>
  JSON.parse(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf-8" }));
