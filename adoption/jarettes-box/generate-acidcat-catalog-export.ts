/**
 * Export Jarette's Box's capability definitions as an AcidCat 0.1 catalog (see spec/adoption.md).
 *
 * Copy this file into a Jarette's Box checkout as tools/generators/generate-acidcat-catalog-export.ts, then run it the
 * way JB runs its own manifest generator:
 *
 *   ACIDCAT_CATALOG_OUT=/path/to/jarettes-box.acidcat.json \
 *     pnpm exec vitest run --config tests/vitest.generator.config.ts tools/generators/generate-acidcat-catalog-export.ts
 *
 * Then put it in canonical form and check it with this repository's toolchain:
 *
 *   node toolchain/src/cli.ts format --write /path/to/jarettes-box.acidcat.json
 *   node toolchain/src/cli.ts check /path/to/jarettes-box.acidcat.json
 *
 * The catalog is built in three steps:
 *   1. Each capability's input, output and error schemas come from JB's own `manifestSchema`. The error union is split
 *      into one failure per `_tag`.
 *   2. The `$defs` each schema carries move up into the catalog's `$defs`. A name that is already taken by a different
 *      type gets a numbered suffix, and the schema's references follow it.
 *   3. Any schema of at least SHARE_MINIMUM characters that appears more than once becomes a shared type. It is named
 *      after its `title`, or else after where it first appears, such as `BarteringRefreshStartOutput`.
 */
import { writeFileSync } from "node:fs";
import { test } from "vitest";
import { Effect, SchemaAST } from "effect";
import { definitions } from "../../packages/acidcat/src/catalog.ts";
import { manifestSchema, walkDefinitions, type JsonObject, type JsonValue } from "../../packages/acidcat-kernel/src/index.ts";

type Schema = { [key: string]: JsonValue };

/** Repeated schemas shorter than this stay inline: sharing them would save less than the reference costs to read. */
const SHARE_MINIMUM = 512;

const REFERENCE_PREFIX = "#/$defs/";

const targets = {
  application: {
    description: "The web app: people through the Vue interface, and in-page agents through WebMCP.",
    bindings: ["typescript", "webmcp"],
  },
  cli: { description: "The command line.", bindings: ["cli"] },
  mcp: { description: "MCP clients of the application Worker.", bindings: ["mcp"] },
};

test("export the AcidCat catalog", async () => {
  const types: Record<string, Schema> = {};
  const capabilities: Record<string, Schema> = {};

  for (const leaf of walkDefinitions(definitions)) {
    const program = await Effect.runPromise(leaf.load);
    const entry: Schema = {
      description: leaf.description,
      audience: [...leaf.audience],
      input: hoist(manifestSchema(program.input), types),
      output: hoist(manifestSchema(program.output), types),
    };
    if (!SchemaAST.isNever(program.error.ast)) {
      const failures: Schema = {};
      for (const [tag, failure] of Object.entries(failuresOf(leaf.id, manifestSchema(program.error)))) {
        failures[tag] = hoist(failure, types);
      }
      entry.failures = failures;
    }
    capabilities[leaf.id] = entry;
  }

  const shared = shareRepeated(capabilities, types);
  const catalog = { acidcat: "0.1", title: "Jarette's Box", targets, $defs: shared.types, capabilities: shared.capabilities };
  writeFileSync(process.env.ACIDCAT_CATALOG_OUT ?? "acidcat.catalog.json", `${JSON.stringify(catalog, null, 2)}\n`);
});

/** Split an error union into one schema per `_tag`, each keeping the `$defs` of the union. */
function failuresOf(id: string, union: JsonObject): Record<string, Schema> {
  const { anyOf, oneOf, $defs, ...rest } = union as Schema;
  const variants = (Array.isArray(anyOf) ? anyOf : Array.isArray(oneOf) ? oneOf : [rest]) as Schema[];
  const local = ($defs ?? {}) as Record<string, Schema>;
  const failures: Record<string, Schema> = {};
  for (const variant of variants) {
    const tag = tagOf(resolveLocal(variant, local));
    if (tag === undefined) throw new Error(`${id}: a failure variant has no literal _tag`);
    if (tag in failures) throw new Error(`${id}: the tag ${tag} appears twice`);
    failures[tag] = $defs === undefined ? variant : { ...variant, $defs };
  }
  return failures;
}

/** Move a schema's own `$defs` into the catalog's types, renaming any that collide, and return the schema without them. */
function hoist(schema: JsonObject, types: Record<string, Schema>): Schema {
  const { $defs, ...body } = schema as Schema;
  const local = ($defs ?? {}) as Record<string, Schema>;
  const renamed: Record<string, string> = {};
  for (const [name, type] of Object.entries(local)) {
    renamed[name] = freeName(name, type, types);
  }
  for (const [name, type] of Object.entries(local)) {
    types[renamed[name]!] = renameReferences(type, renamed) as Schema;
  }
  return renameReferences(body, renamed) as Schema;
}

/** `name` if it is free or already holds this exact type; otherwise the first free `name_2`, `name_3`, … */
function freeName(name: string, type: Schema, types: Record<string, Schema>): string {
  const wanted = JSON.stringify(type);
  for (let attempt = 1; ; attempt += 1) {
    const candidate = attempt === 1 ? name : `${name}_${attempt}`;
    const existing = types[candidate];
    if (existing === undefined || JSON.stringify(existing) === wanted) return candidate;
  }
}

function renameReferences(value: JsonValue, renamed: Record<string, string>): JsonValue {
  if (Array.isArray(value)) return value.map((item) => renameReferences(item, renamed));
  if (value === null || typeof value !== "object") return value;
  const copy: Schema = {};
  for (const [key, inner] of Object.entries(value)) {
    if (key === "$ref" && typeof inner === "string" && inner.startsWith(REFERENCE_PREFIX)) {
      const name = inner.slice(REFERENCE_PREFIX.length);
      copy[key] = `${REFERENCE_PREFIX}${renamed[name] ?? name}`;
    } else {
      copy[key] = renameReferences(inner, renamed);
    }
  }
  return copy;
}

/** Turn every repeated schema of at least SHARE_MINIMUM characters into a shared type. */
function shareRepeated(capabilities: Record<string, Schema>, types: Record<string, Schema>) {
  const counts = new Map<string, number>();
  const count = (value: JsonValue): void => {
    if (value === null || typeof value !== "object") return;
    if (!Array.isArray(value)) {
      const text = JSON.stringify(value);
      if (text.length >= SHARE_MINIMUM) counts.set(text, (counts.get(text) ?? 0) + 1);
    }
    (Array.isArray(value) ? value : Object.values(value)).forEach(count);
  };
  for (const capability of Object.values(capabilities)) {
    for (const schema of schemasOf(capability)) count(schema);
  }
  for (const type of Object.values(types)) count(type);

  const sharedNames = new Map<string, string>();
  const share = (value: JsonValue, path: readonly string[]): JsonValue => {
    if (value === null || typeof value !== "object") return value;
    if (Array.isArray(value)) return value.map((item, index) => share(item, [...path, `Item${index}`]));
    const text = JSON.stringify(value);
    const repeated = text.length >= SHARE_MINIMUM && (counts.get(text) ?? 0) > 1;
    if (!repeated) return shareMembers(value, path);
    let name = sharedNames.get(text);
    if (name === undefined) {
      const title = typeof value.title === "string" && /^[A-Za-z][A-Za-z0-9_]*$/.test(value.title) ? value.title : undefined;
      name = freeName(title ?? pascal(path), value, types);
      sharedNames.set(text, name);
      types[name] = shareMembers(value, path);
    }
    return { $ref: `${REFERENCE_PREFIX}${name}` };
  };
  const shareMembers = (value: Schema, path: readonly string[]): Schema => {
    const copy: Schema = {};
    for (const [key, inner] of Object.entries(value)) {
      copy[key] = key === "properties" ? shareProperties(inner, path) : share(inner, [...path, key]);
    }
    return copy;
  };
  const shareProperties = (value: JsonValue, path: readonly string[]): JsonValue => {
    if (value === null || typeof value !== "object" || Array.isArray(value)) return value;
    return Object.fromEntries(Object.entries(value).map(([name, inner]) => [name, share(inner, [...path, name])]));
  };

  const shared: Record<string, Schema> = {};
  for (const [id, capability] of Object.entries(capabilities)) {
    const copy: Schema = { ...capability };
    for (const member of ["input", "output"] as const) {
      if (capability[member] !== undefined) copy[member] = share(capability[member]!, [id, member]);
    }
    if (capability.failures !== undefined) {
      copy.failures = Object.fromEntries(
        Object.entries(capability.failures as Schema).map(([tag, schema]) => [tag, share(schema, [id, tag])]),
      );
    }
    shared[id] = copy;
  }
  for (const [name, type] of Object.entries(types)) {
    if (![...sharedNames.values()].includes(name)) types[name] = shareMembers(type, [name]);
  }
  return { types, capabilities: shared };
}

function schemasOf(capability: Schema): JsonValue[] {
  const failures = (capability.failures ?? {}) as Schema;
  return [capability.input, capability.output, ...Object.values(failures)].filter((schema) => schema !== undefined);
}

/** `["bartering.refresh.start", "output", "workbench"]` → `BarteringRefreshStartOutputWorkbench` */
function pascal(path: readonly string[]): string {
  return path
    .flatMap((part) => part.split(/[^A-Za-z0-9]+/))
    .filter((word) => word.length > 0)
    .map((word) => word[0]!.toUpperCase() + word.slice(1))
    .join("");
}

function resolveLocal(schema: Schema, local: Record<string, Schema>): Schema {
  const reference = schema.$ref;
  if (typeof reference === "string" && reference.startsWith(REFERENCE_PREFIX)) {
    return resolveLocal(local[reference.slice(REFERENCE_PREFIX.length)] ?? {}, local);
  }
  return schema;
}

function tagOf(schema: Schema): string | undefined {
  const tag = (schema.properties as Record<string, Schema> | undefined)?._tag;
  if (tag === undefined) return undefined;
  if (typeof tag.const === "string") return tag.const;
  if (Array.isArray(tag.enum) && tag.enum.length === 1 && typeof tag.enum[0] === "string") return tag.enum[0];
  return undefined;
}
