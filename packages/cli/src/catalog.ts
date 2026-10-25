/**
 * The catalog operations that the specification defines: the catalog rules, views and bundling.
 * See spec/catalog.md and spec/conformance.md.
 */
import { canonicalText } from "@acid-cat/catalog";
import { bundle, REFERENCE, schemasOf, viewOf, visitObjects } from "@acid-cat/spec-ts";
import type { CatalogCapability, CatalogDocument as Catalog } from "@acid-cat/spec-ts";
import { Result, Schema, SchemaIssue, SchemaRepresentation } from "effect";
import type { JsonSchema } from "effect";

import catalogJsonSchema from "../../../schemas/catalog.schema.json" with { type: "json" };
import { isObject, isRecordOf, isStringArray } from "./json.ts";
import type { JsonObject } from "./json.ts";

export { bundle, viewOf };
export type { Catalog };

/** The result of a check. An error breaks a rule. A warning breaks a recommendation. */
export interface Report {
  readonly errors: readonly string[];
  readonly warnings: readonly string[];
}

const KNOWN_MEMBERS = {
  catalog: ["acidcat", "title", "description", "targets", "$defs", "capabilities"],
  target: ["bindings", "description", "options"],
  capability: ["description", "audience", "input", "output", "failures", "readOnly", "state"],
};

/** The catalog schema (schemas/catalog.schema.json), imported as an Effect schema. */
const decodeCatalog = (() => {
  const { $defs, $schema: _schema, $id: _id, ...root } = catalogJsonSchema;
  const definitions: JsonSchema.Definitions = $defs;
  const schema = SchemaRepresentation.fromJsonSchemaDocument(
    { dialect: "draft-2020-12", schema: root, definitions },
    { patterns: "apply" },
  );
  // A schema imported from JSON Schema has no transformations, so its type side checks the same values. The type side
  // needs no services to decode.
  return Schema.decodeUnknownResult(Schema.toType(schema));
})();

/** True if `key` is absent from the object, or if `isMember` is true for its value. */
const optional = (object: JsonObject, key: string, isMember: (value: unknown) => boolean): boolean =>
  !(key in object) || isMember(object[key]);

const isString = (value: unknown): value is string => typeof value === "string";

const isTarget = (value: unknown): value is Catalog["targets"][string] => isObject(value) && isStringArray(value.bindings);

const isCapability = (value: unknown): value is CatalogCapability =>
  isObject(value) &&
  typeof value.description === "string" &&
  optional(value, "audience", isStringArray) &&
  optional(value, "input", isObject) &&
  optional(value, "output", isObject) &&
  optional(value, "state", isObject) &&
  optional(value, "failures", (failures) => isRecordOf(failures, isObject)) &&
  optional(value, "readOnly", (readOnly) => typeof readOnly === "boolean");

/**
 * True if the value has the members and the member types of a catalog. It does not check the catalog rules: `check`
 * does that.
 */
export const isCatalog = (value: unknown): value is Catalog =>
  isObject(value) &&
  typeof value.acidcat === "string" &&
  optional(value, "title", isString) &&
  optional(value, "description", isString) &&
  isRecordOf(value.targets, isTarget) &&
  optional(value, "$defs", (types) => isRecordOf(types, isObject)) &&
  isRecordOf(value.capabilities, isCapability);

const formatIssues = SchemaIssue.makeFormatterStandardSchemaV1();

/** Check a catalog. When `text` is given, the file must also be in canonical form. */
export function check(document: unknown, text?: string): Report {
  const decoded = decodeCatalog(document);
  if (Result.isFailure(decoded)) {
    const errors = formatIssues(decoded.failure.issue).issues.map(
      (issue) => `${(issue.path ?? []).map((key) => `[${JSON.stringify(key)}]`).join("") || "the catalog"}: ${issue.message}`,
    );
    return { errors, warnings: [] };
  }
  if (!isCatalog(document)) {
    // The catalog schema requires these members, so this error is a defect of the schema.
    return { errors: ["the catalog: the members do not have the types of a catalog"], warnings: [] };
  }
  const catalog = document;
  const errors = ruleErrors(catalog);
  const warnings = [...unknownMembers(catalog), ...(errors.length === 0 ? schemaWarnings(catalog) : [])];
  if (text !== undefined && text !== canonicalText(catalog)) {
    warnings.push("the file is not in canonical form: run `acid-cat format --write`");
  }
  return { errors, warnings };
}

/** The catalog rules that the catalog schema cannot express. */
function ruleErrors(catalog: Catalog): string[] {
  const errors: string[] = [];
  const types = catalog.$defs ?? {};
  for (const [name, type] of Object.entries(types)) {
    errors.push(...referenceErrors(type, types).map((error) => `type ${name} ${error}`));
  }
  for (const [id, capability] of Object.entries(catalog.capabilities)) {
    for (const target of capability.audience ?? []) {
      if (!(target in catalog.targets)) errors.push(`${id}: the audience names ${target}, which is not a target`);
    }
    for (const [member, schema] of schemasOf(capability)) {
      const references = referenceErrors(schema, types);
      errors.push(...references.map((error) => `${id} ${member} ${error}`));
      if (member === "input" && references.length === 0 && bundle(schema, types).type !== "object") {
        errors.push(`${id}: the input is not an object`);
      }
    }
  }
  return errors;
}

/** Members that the specification does not define and that have no `x-` prefix. */
function unknownMembers(catalog: Catalog): string[] {
  const unknown = (where: string, value: JsonObject, known: readonly string[]) =>
    Object.keys(value)
      .filter((key) => !known.includes(key) && !key.startsWith("x-"))
      .map((key) => `${where}: unknown member ${key}; give extensions an x- prefix`);
  return [
    ...unknown("the catalog", catalog, KNOWN_MEMBERS.catalog),
    ...Object.entries(catalog.targets).flatMap(([name, target]) =>
      unknown(`target ${name}`, target, KNOWN_MEMBERS.target),
    ),
    ...Object.entries(catalog.capabilities).flatMap(([id, capability]) =>
      unknown(id, capability, KNOWN_MEMBERS.capability),
    ),
  ];
}

/** Schemas that cannot be imported as Effect schemas. They can still be valid JSON Schema, so this is a warning. */
function schemaWarnings(catalog: Catalog): string[] {
  const definitions: JsonSchema.Definitions = catalog.$defs ?? {};
  const warnings: string[] = [];
  for (const [id, capability] of Object.entries(catalog.capabilities)) {
    for (const [member, schema] of schemasOf(capability)) {
      try {
        SchemaRepresentation.fromJsonSchemaMultiDocument(
          { dialect: "draft-2020-12", schemas: [schema], definitions },
          { patterns: "ignore" },
        );
      } catch (cause) {
        warnings.push(`${id} ${member}: cannot check this schema: ${cause instanceof Error ? cause.message : String(cause)}`);
      }
    }
  }
  return warnings;
}

function referenceErrors(schema: unknown, types: { readonly [name: string]: JsonObject }): string[] {
  const errors: string[] = [];
  visitObjects(schema, (node) => {
    if ("$defs" in node) errors.push("has its own $defs; put shared types in the catalog's $defs");
    if (node.$ref === undefined) return;
    const name = typeof node.$ref === "string" ? REFERENCE.exec(node.$ref)?.[1] : undefined;
    if (name === undefined || !(name in types)) {
      const reference = typeof node.$ref === "string" ? node.$ref : JSON.stringify(node.$ref);
      errors.push(`references ${reference}, which is not a type`);
    }
  });
  return errors;
}

