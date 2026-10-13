/**
 * The catalog operations the specification defines: the rules a catalog must follow, its views, and bundling.
 * See spec/catalog.md.
 */
import { readFileSync } from "node:fs";

import { Ajv2020 } from "ajv/dist/2020.js";
import addFormats from "ajv-formats";

import { canonicalText } from "@acid-cat/catalog";

export type Schema = Record<string, unknown>;

export interface Capability {
  readonly audience?: readonly string[];
  readonly input?: Schema;
  readonly output?: Schema;
  readonly state?: Schema;
  readonly failures?: Record<string, Schema>;
  readonly [member: string]: unknown;
}

export interface Catalog {
  readonly acidcat: string;
  readonly targets: Record<string, unknown>;
  readonly $defs?: Record<string, Schema>;
  readonly capabilities: Record<string, Capability>;
  readonly [member: string]: unknown;
}

const REFERENCE = /^#\/\$defs\/([A-Za-z][A-Za-z0-9_]*)$/;

const ajv = new Ajv2020({ allErrors: true, strict: false });
addFormats.default(ajv);
const validateShape = ajv.compile(
  JSON.parse(readFileSync(new URL("../../../schemas/catalog.schema.json", import.meta.url), "utf-8")) as object,
);

/**
 * Every way a catalog fails to conform (spec/conformance.md#catalog): its shape against the catalog schema, then the
 * rules the schema cannot express. When `text` is given, it must also be in canonical form.
 */
export function problemsOf(catalog: unknown, text?: string): string[] {
  if (!validateShape(catalog)) return [ajv.errorsText(validateShape.errors)];
  const problems = ruleProblems(catalog as Catalog);
  if (text !== undefined && text !== canonicalText(catalog)) {
    problems.push("the file is not in canonical form; run `acid-cat format --write`");
  }
  return problems;
}

/** The catalog rules that JSON Schema cannot express. */
export function ruleProblems(catalog: Catalog): string[] {
  const found: string[] = [];
  const types = catalog.$defs ?? {};

  for (const [name, type] of Object.entries(types)) {
    found.push(...referenceProblems(type, types).map((problem) => `type ${name} ${problem}`));
  }

  for (const [id, capability] of Object.entries(catalog.capabilities)) {
    for (const target of capability.audience ?? []) {
      if (!(target in catalog.targets)) found.push(`${id} names the undeclared target ${target}`);
    }
    for (const [member, schema] of schemasOf(capability)) {
      const references = referenceProblems(schema, types);
      found.push(...references.map((problem) => `${id} ${member} ${problem}`));
      if (references.length > 0) continue;
      const bundled = bundle(schema, types);
      if (member === "input" && bundled.type !== "object") found.push(`${id} input does not describe an object`);
      try {
        ajv.compile(bundled);
      } catch (cause) {
        found.push(`${id} ${member} does not compile: ${String(cause)}`);
      }
    }
  }
  return found;
}

/**
 * The view of a target (spec/catalog.md#views): only that target, only the capabilities whose audience names it, each
 * with that target alone as its audience, and only the types those capabilities reach.
 */
export function viewOf(catalog: Catalog, target: string): Catalog {
  const types = catalog.$defs ?? {};
  const capabilities = Object.fromEntries(
    Object.entries(catalog.capabilities)
      .filter(([, capability]) => (capability.audience ?? []).includes(target))
      .map(([id, capability]) => [id, { ...capability, audience: [target] }]),
  );
  const reached = new Map<string, Schema>();
  for (const capability of Object.values(capabilities)) {
    for (const [, schema] of schemasOf(capability)) reach(schema, types, reached);
  }
  const { $defs: _, ...rest } = catalog;
  return {
    ...rest,
    targets: target in catalog.targets ? { [target]: catalog.targets[target] } : {},
    ...(reached.size > 0 ? { $defs: Object.fromEntries(reached) } : {}),
    capabilities,
  };
}

/**
 * Bundle a schema (spec/catalog.md#bundling): copy every type it reaches into its own `$defs`. A schema that is only
 * a `$ref` becomes the referenced type itself.
 */
export function bundle(schema: Schema, types: Record<string, Schema>): Schema {
  const only = Object.keys(schema).length === 1 ? REFERENCE.exec(String(schema.$ref))?.[1] : undefined;
  const base = only === undefined ? schema : (types[only] ?? schema);
  const reached = new Map<string, Schema>();
  reach(base, types, reached);
  return reached.size === 0 ? base : { ...base, $defs: Object.fromEntries(reached) };
}

/** A capability's schemas, each with the member it belongs to. */
function schemasOf(capability: Capability): [string, Schema][] {
  const members: [string, Schema | undefined][] = [
    ["input", capability.input],
    ["output", capability.output],
    ["state", capability.state],
    ...Object.entries(capability.failures ?? {}).map(([tag, schema]): [string, Schema] => [`failure ${tag}`, schema]),
  ];
  return members.filter((entry): entry is [string, Schema] => entry[1] !== undefined);
}

function reach(schema: unknown, types: Record<string, Schema>, reached: Map<string, Schema>): void {
  visit(schema, (node) => {
    const name = typeof node.$ref === "string" ? REFERENCE.exec(node.$ref)?.[1] : undefined;
    const type = name === undefined ? undefined : types[name];
    if (name !== undefined && type !== undefined && !reached.has(name)) {
      reached.set(name, type);
      reach(type, types, reached);
    }
  });
}

/** Problems with a schema's references: nested `$defs`, and `$ref`s that do not name a catalog type. */
function referenceProblems(schema: unknown, types: Record<string, Schema>): string[] {
  const found: string[] = [];
  visit(schema, (node) => {
    if ("$defs" in node) found.push("carries its own $defs");
    if (node.$ref === undefined) return;
    const name = typeof node.$ref === "string" ? REFERENCE.exec(node.$ref)?.[1] : undefined;
    if (name === undefined || !(name in types)) found.push(`references ${String(node.$ref)}, which is not a catalog type`);
  });
  return found;
}

function visit(value: unknown, onObject: (node: Schema) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visit(item, onObject));
  } else if (value !== null && typeof value === "object") {
    onObject(value as Schema);
    Object.values(value).forEach((item) => visit(item, onObject));
  }
}
