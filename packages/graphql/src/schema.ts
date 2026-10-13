/**
 * The GraphQL schema of a view (spec/bindings/graphql.md#schema), as SDL text. This module is pure.
 */
import { graphqlFieldName, REFERENCE } from "@acid-cat/spec";
import type { CatalogDocument, JsonObject } from "@acid-cat/spec";

/** How one capability appears in the GraphQL schema. */
export interface Operation {
  readonly id: string;
  readonly field: string;
  readonly root: "Query" | "Mutation";
  /** The object type of a value. */
  readonly valueType: string;
  /** If the value type wraps the value in a `value` field, because the output is not an object. */
  readonly wrapped: boolean;
  /** The object type of each failure, by tag. */
  readonly failureTypes: { readonly [tag: string]: string };
  /** If the field has an `input` argument. */
  readonly hasInput: boolean;
}

export interface GraphqlSchema {
  readonly sdl: string;
  readonly operations: ReadonlyMap<string, Operation>;
}

const NAME = /^[_A-Za-z][_0-9A-Za-z]*$/;
const INT32 = 2 ** 31;

/** Make the GraphQL schema of a view. */
export function graphqlSchema(view: CatalogDocument): GraphqlSchema {
  const types = view.$defs ?? {};
  const definitions: string[] = [];
  const used = new Set(["Query", "Mutation", "JSON", "AcidcatCapability"]);
  const named = new Map<string, string>();

  const unique = (wanted: string): string => {
    let name = wanted;
    for (let index = 2; used.has(name); index += 1) name = `${wanted}${index}`;
    used.add(name);
    return name;
  };

  const describe = (schema: JsonObject, indent = ""): string =>
    typeof schema.description === "string" ? `${indent}${JSON.stringify(schema.description)}\n` : "";

  const resolve = (schema: JsonObject): { readonly schema: JsonObject; readonly name?: string } => {
    const name = typeof schema.$ref === "string" ? REFERENCE.exec(schema.$ref)?.[1] : undefined;
    const type = name === undefined ? undefined : types[name];
    return type === undefined ? { schema } : { schema: type, name: name! };
  };

  const isObject = (schema: JsonObject): boolean => {
    const properties = schema.properties as JsonObject | undefined;
    return (
      schema.type === "object" &&
      properties !== undefined &&
      Object.keys(properties).length > 0 &&
      Object.keys(properties).every((key) => NAME.test(key))
    );
  };

  /** The GraphQL type of a schema, without the non-null mark. */
  const typeOf = (original: JsonObject, hint: string, mode: "input" | "output"): string => {
    const { schema, name } = resolve(original);
    const base = name ?? hint;
    if (Array.isArray(schema.enum) && schema.enum.length > 0 && schema.enum.every((value) => typeof value === "string" && NAME.test(value) && !["true", "false", "null"].includes(value))) {
      const key = `enum:${JSON.stringify(schema.enum)}:${base}`;
      const existing = named.get(key);
      if (existing !== undefined) return existing;
      const typeName = unique(base);
      named.set(key, typeName);
      definitions.push(`${describe(schema)}enum ${typeName} {\n${(schema.enum as string[]).map((value) => `  ${value}`).join("\n")}\n}`);
      return typeName;
    }
    if (typeof schema.const === "string" || schema.type === "string") return "String";
    if (schema.type === "boolean") return "Boolean";
    if (schema.type === "number") return "Float";
    if (schema.type === "integer") {
      const minimum = typeof schema.minimum === "number" ? schema.minimum : -Infinity;
      const maximum = typeof schema.maximum === "number" ? schema.maximum : Infinity;
      return minimum >= -INT32 && maximum < INT32 ? "Int" : "Float";
    }
    if (schema.type === "array" && schema.items !== undefined && typeof schema.items === "object") {
      return `[${typeOf(schema.items as JsonObject, `${base}Item`, mode)}!]`;
    }
    if (isObject(schema)) {
      const key = `${mode}:${name ?? JSON.stringify(schema)}`;
      const existing = named.get(key);
      if (existing !== undefined) return existing;
      const typeName = unique(mode === "input" ? `${base}Input` : base);
      named.set(key, typeName);
      const required = new Set((schema.required ?? []) as readonly string[]);
      const fields = Object.entries(schema.properties as { readonly [key: string]: JsonObject }).map(
        ([field, property]) =>
          `${describe(property, "  ")}  ${field}: ${typeOf(property, `${typeName}${pascal(field)}`, mode)}${required.has(field) ? "!" : ""}`,
      );
      definitions.push(`${describe(schema)}${mode === "input" ? "input" : "type"} ${typeName} {\n${fields.join("\n")}\n}`);
      return typeName;
    }
    return "JSON";
  };

  const operations = new Map<string, Operation>();
  const roots = { Query: [] as string[], Mutation: [] as string[] };
  for (const [id, capability] of Object.entries(view.capabilities)) {
    const field = graphqlFieldName(id);
    const prefix = pascal(field);

    const input = capability.input === undefined ? undefined : resolve(capability.input).schema;
    const hasInput = input !== undefined && Object.keys((input.properties ?? {}) as object).length > 0;
    const inputType = hasInput ? typeOf(capability.input!, prefix, "input") : undefined;
    const inputRequired = hasInput && ((input!.required ?? []) as readonly string[]).length > 0;

    const output = capability.output === undefined ? undefined : resolve(capability.output);
    let valueType: string;
    let wrapped: boolean;
    if (output !== undefined && isObject(output.schema)) {
      valueType = typeOf(capability.output!, `${prefix}Value`, "output");
      wrapped = false;
    } else {
      valueType = unique(`${prefix}Value`);
      wrapped = true;
      const inner = capability.output === undefined ? "JSON" : typeOf(capability.output, `${prefix}Value`, "output");
      definitions.push(`"""The value of ${id}."""\ntype ${valueType} {\n  value: ${inner}\n}`);
    }

    const failureTypes: Record<string, string> = {};
    for (const [tag, schema] of Object.entries(capability.failures ?? {})) {
      // Each failure value has a `_tag`, also when its schema does not list it.
      const resolved = resolve(schema);
      const properties = { ...((resolved.schema.properties ?? {}) as JsonObject), _tag: { type: "string" } };
      const required = [...new Set(["_tag", ...((resolved.schema.required ?? []) as readonly string[])])];
      const failure = { ...resolved.schema, type: "object", properties, required };
      failureTypes[tag] = typeOf(failure, resolved.name ?? `${prefix}${pascal(tag)}`, "output");
    }

    const union = unique(`${prefix}Result`);
    definitions.push(`"""The result of ${id}: a value or a failure."""\nunion ${union} = ${[valueType, ...Object.values(failureTypes)].join(" | ")}`);
    const root = capability.readOnly === true ? "Query" : "Mutation";
    const argument = inputType === undefined ? "" : `(input: ${inputType}${inputRequired ? "!" : ""})`;
    roots[root].push(`${describe(capability, "  ")}  ${field}${argument}: ${union}`);
    operations.set(id, { id, field, root, valueType, wrapped, failureTypes, hasInput });
  }

  const sdl = [
    `"""Any JSON value."""\nscalar JSON`,
    `"""A capability and its availability."""\ntype AcidcatCapability {\n  id: String!\n  available: Boolean!\n  reason: String\n}`,
    ...definitions,
    `type Query {\n  """The capabilities of this API, with their availability."""\n  acidcatCapabilities: [AcidcatCapability!]!\n  """The view of the target."""\n  acidcatCatalog: JSON!\n${roots.Query.join("\n")}\n}`,
    `type Mutation {\n  """Call a capability by id. The answer is the outcome in its JSON form."""\n  acidcatInvoke(id: String!, input: JSON): JSON!\n${roots.Mutation.join("\n")}\n}`,
  ].join("\n\n");

  return { sdl: `${sdl}\n`, operations };
}

const pascal = (text: string): string =>
  text
    .split(/[^A-Za-z0-9]+/)
    .filter((word) => word !== "")
    .map((word) => word.charAt(0).toUpperCase() + word.slice(1))
    .join("");
