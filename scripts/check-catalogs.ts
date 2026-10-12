/**
 * Check every example catalog against the specification.
 *
 * For each `examples/<name>.pkl`, the committed `examples/<name>.acidcat.json` must be exactly what Pkl renders
 * now. The rendered catalog must then validate against `schemas/catalog.schema.json` and follow the rules the schema
 * cannot express (see spec/conformance.md). Every capability schema must compile once bundled, which is the form
 * that surfaces such as MCP receive.
 *
 * Given catalog files instead, it checks those the same way, without the Pkl step. Adoption uses this for catalogs
 * that applications generate from code.
 *
 * Usage: node scripts/check-catalogs.ts [catalog.json ...]
 */
import { execFileSync } from "node:child_process";
import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

type Schema = Record<string, unknown>;

interface Capability {
  readonly audience?: readonly string[];
  readonly input?: Schema;
  readonly output?: Schema;
  readonly state?: Schema;
  readonly failures?: Record<string, Schema>;
}

interface Catalog {
  readonly targets: Record<string, unknown>;
  readonly $defs?: Record<string, Schema>;
  readonly capabilities: Record<string, Capability>;
}

const REFERENCE = /^#\/\$defs\/([A-Za-z][A-Za-z0-9_]*)$/;

const root = path.resolve(import.meta.dirname, "..");
const examples = path.join(root, "examples");

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateCatalog = ajv.compile(readJson(path.join(root, "schemas/catalog.schema.json")));

const problems: string[] = [];
const files = process.argv.slice(2);

for (const file of files) {
  checkCatalog(path.basename(file), readFileSync(file, "utf-8"));
}

const sources = files.length > 0 ? [] : readdirSync(examples).filter((name) => name.endsWith(".pkl"));
for (const source of sources) {
  const name = source.slice(0, -".pkl".length);
  const renderedPath = path.join(examples, `${name}.acidcat.json`);
  const rendered = execFileSync("pkl", ["eval", path.join(examples, source)], { encoding: "utf-8" });

  if (rendered !== readFileSync(renderedPath, "utf-8")) {
    problems.push(`${name}: ${name}.acidcat.json is stale; run \`moon run examples\``);
  }

  checkCatalog(name, rendered);
}

if (problems.length > 0) {
  process.stderr.write(`${problems.join("\n")}\n`);
  process.exit(1);
}
process.stdout.write(files.length > 0 ? "Every catalog conforms.\n" : "Every example catalog conforms.\n");

function checkCatalog(name: string, text: string): void {
  const catalog = JSON.parse(text) as Catalog;
  if (!validateCatalog(catalog)) {
    problems.push(`${name}: ${ajv.errorsText(validateCatalog.errors)}`);
    return;
  }
  problems.push(...ruleProblems(catalog).map((problem) => `${name}: ${problem}`));
}

/** The catalog rules that JSON Schema cannot express. */
function ruleProblems(catalog: Catalog): string[] {
  const found: string[] = [];
  const types = catalog.$defs ?? {};

  for (const [typeName, type] of Object.entries(types)) {
    found.push(...referenceProblems(type, types).map((problem) => `type ${typeName} ${problem}`));
  }

  for (const [id, capability] of Object.entries(catalog.capabilities)) {
    for (const target of capability.audience ?? []) {
      if (!(target in catalog.targets)) {
        found.push(`${id} names the undeclared target ${target}`);
      }
    }

    const schemas: [string, Schema | undefined][] = [
      ["input", capability.input],
      ["output", capability.output],
      ["state", capability.state],
      ...Object.entries(capability.failures ?? {}).map(([tag, schema]): [string, Schema] => [`failure ${tag}`, schema]),
    ];
    for (const [member, schema] of schemas) {
      if (schema === undefined) {
        continue;
      }
      const references = referenceProblems(schema, types);
      found.push(...references.map((problem) => `${id} ${member} ${problem}`));
      if (references.length > 0) {
        continue;
      }
      const bundled = bundle(schema, types);
      if (member === "input" && bundled.type !== "object") {
        found.push(`${id} input does not describe an object`);
      }
      try {
        ajv.compile(bundled);
      } catch (cause) {
        found.push(`${id} ${member} does not compile: ${String(cause)}`);
      }
    }
  }
  return found;
}

/** Problems with a schema's references: nested `$defs`, and `$ref`s that do not name a catalog type. */
function referenceProblems(schema: unknown, types: Record<string, Schema>): string[] {
  const found: string[] = [];
  visit(schema, (node) => {
    if ("$defs" in node) {
      found.push("carries its own $defs");
    }
    const reference = node.$ref;
    if (reference === undefined) {
      return;
    }
    const name = typeof reference === "string" ? REFERENCE.exec(reference)?.[1] : undefined;
    if (name === undefined || !(name in types)) {
      found.push(`references ${String(reference)}, which is not a catalog type`);
    }
  });
  return found;
}

/**
 * Bundle a schema (spec/catalog.md#bundling): copy every type it reaches into its own `$defs`. A schema that is only
 * a `$ref` becomes the referenced type itself.
 */
function bundle(schema: Schema, types: Record<string, Schema>): Schema {
  const reached = new Map<string, Schema>();
  const reach = (node: unknown): void => {
    visit(node, (inner) => {
      const name = typeof inner.$ref === "string" ? REFERENCE.exec(inner.$ref)?.[1] : undefined;
      const type = name === undefined ? undefined : types[name];
      if (name !== undefined && type !== undefined && !reached.has(name)) {
        reached.set(name, type);
        reach(type);
      }
    });
  };
  reach(schema);

  const only = Object.keys(schema).length === 1 ? REFERENCE.exec(String(schema.$ref))?.[1] : undefined;
  const base = only === undefined ? schema : (types[only] ?? schema);
  return reached.size === 0 ? base : { ...base, $defs: Object.fromEntries(reached) };
}

/** Call `visit` on every object inside a JSON value, including the value itself. */
function visit(value: unknown, onObject: (node: Schema) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visit(item, onObject));
    return;
  }
  if (value !== null && typeof value === "object") {
    onObject(value as Schema);
    Object.values(value).forEach((item) => visit(item, onObject));
  }
}

function readJson(file: string): object {
  return JSON.parse(readFileSync(file, "utf-8")) as object;
}
