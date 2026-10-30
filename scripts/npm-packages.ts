/**
 * The packages that this repository publishes to npm, and how to pack them.
 *
 * The list is in publishing order: each package comes after the packages that it depends on.
 */
import { execFileSync } from "node:child_process";
import path from "node:path";

export const root = path.resolve(import.meta.dirname, "..");

// --- JSON that the scripts read ----------------------------------------------------------------------------------
// Each function checks the value at run time, and throws an error that names the value and the member if it does not
// agree. The types come from these checks.

/** A JSON object. */
export type JsonObject = { readonly [key: string]: unknown };

export const isJsonObject = (value: unknown): value is JsonObject =>
  typeof value === "object" && value !== null && !Array.isArray(value);

/** Parse JSON text whose value must be an object. `what` names the text in an error. */
export function parseObject(text: string, what: string): JsonObject {
  const value: unknown = JSON.parse(text);
  if (!isJsonObject(value)) throw new Error(`${what} is not a JSON object.`);
  return value;
}

/** A member of `object` that must be an object. */
export function objectMember(object: JsonObject, key: string, what: string): JsonObject {
  const value = object[key];
  if (!isJsonObject(value)) throw new Error(`${what}: "${key}" is not an object.`);
  return value;
}

/** A member of `object` that must be a string. */
export function stringMember(object: JsonObject, key: string, what: string): string {
  const value = object[key];
  if (typeof value !== "string") throw new Error(`${what}: "${key}" is not a string.`);
  return value;
}

/** A member of `object` that must be an array of objects. */
export function objectArrayMember(object: JsonObject, key: string, what: string): JsonObject[] {
  const value = object[key];
  if (!Array.isArray(value) || !value.every(isJsonObject)) throw new Error(`${what}: "${key}" is not an array of objects.`);
  return value;
}

/** A value that must be an object whose members are all strings. */
export function stringRecord(value: unknown, what: string): Record<string, string> {
  if (!isJsonObject(value)) throw new Error(`${what} is not an object.`);
  const record: Record<string, string> = {};
  for (const [key, member] of Object.entries(value)) {
    if (typeof member !== "string") throw new Error(`${what}: "${key}" is not a string.`);
    record[key] = member;
  }
  return record;
}

export const npmPackages = [
  { name: "@acid-cat/spec-ts", directory: "packages/spec-ts" },
  { name: "@acid-cat/mcp-handshake", directory: "packages/mcp-handshake" },
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
  const what = `The output of pnpm pack for ${npmPackage.name}`;
  const packed = parseObject(output, what);
  return {
    name: stringMember(packed, "name", what),
    version: stringMember(packed, "version", what),
    tarball: path.resolve(destination, path.basename(stringMember(packed, "filename", what))),
    files: objectArrayMember(packed, "files", what).map((file) => stringMember(file, "path", what)),
  };
};

/** The manifest inside a tarball. */
export const packedManifest = (tarball: string): JsonObject =>
  parseObject(execFileSync("tar", ["-xzOf", tarball, "package/package.json"], { encoding: "utf-8" }), `The manifest in ${tarball}`);
