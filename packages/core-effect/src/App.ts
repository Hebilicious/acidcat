/**
 * An application: its targets and its capabilities. The application writes its own catalog, so the code is the
 * source and the catalog is checked at build time. See spec/catalog.md#build-time-and-run-time.
 */
import { canonicalText } from "@acid-cat/catalog";
import { REFERENCE } from "@acid-cat/spec";
import type { CatalogCapability, CatalogDocument, JsonObject } from "@acid-cat/spec";
import { Schema } from "effect";

import type * as Capability from "./Capability.ts";

export interface Target {
  /** The bindings that serve the target, for example `["mcp"]`. */
  readonly bindings: readonly string[];
  readonly description?: string | undefined;
  readonly options?: JsonObject | undefined;
}

export interface App<R = never> {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly targets: { readonly [name: string]: Target };
  readonly capabilities: readonly Capability.Any<R>[];
}

/** Declare an application. */
export const make = <const Capabilities extends readonly Capability.Any[]>(app: {
  readonly title?: string;
  readonly description?: string;
  readonly targets: { readonly [name: string]: Target };
  readonly capabilities: Capabilities;
}): App<Capability.Services<Capabilities[number]>> => app;

/** The catalog of an application, as a JSON document. */
export function document(app: App<any>): CatalogDocument {
  const types: Record<string, JsonObject> = {};

  const toJson = (schema: Schema.Top, where: string): JsonObject => {
    const { schema: json, definitions } = Schema.toJsonSchemaDocument(schema);
    for (const [name, definition] of Object.entries(definitions)) {
      const existing = types[name];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(definition)) {
        throw new Error(`${where}: two different schemas have the identifier ${name}. Give each one its own identifier.`);
      }
      types[name] = definition as JsonObject;
    }
    return json as JsonObject;
  };

  const capabilities: Record<string, CatalogCapability> = {};
  for (const capability of app.capabilities) {
    if (capability.id in capabilities) throw new Error(`The capability ${capability.id} is declared two times.`);
    const failures: Record<string, JsonObject> = {};
    for (const failure of capability.failures ?? []) {
      const json = toJson(failure, capability.id);
      const tag = tagOf(json, types);
      if (tag === undefined) throw new Error(`${capability.id}: each failure must be a Schema.TaggedStruct.`);
      failures[tag] = json;
    }
    capabilities[capability.id] = {
      description: capability.description,
      audience: capability.audience,
      ...(capability.input === undefined ? {} : { input: objectSchema(toJson(capability.input, capability.id)) }),
      ...(capability.output === undefined ? {} : { output: toJson(capability.output, capability.id) }),
      ...(Object.keys(failures).length === 0 ? {} : { failures }),
      ...(capability.readOnly === true ? { readOnly: true } : {}),
    };
  }

  return {
    acidcat: "0.1",
    ...(app.title === undefined ? {} : { title: app.title }),
    ...(app.description === undefined ? {} : { description: app.description }),
    targets: Object.fromEntries(
      Object.entries(app.targets).map(([name, target]) => [
        name,
        {
          bindings: target.bindings,
          ...(target.description === undefined ? {} : { description: target.description }),
          ...(target.options === undefined ? {} : { options: target.options }),
        },
      ]),
    ),
    ...(Object.keys(types).length === 0 ? {} : { $defs: types }),
    capabilities,
  };
}

/** The catalog of an application, as text in canonical form. */
export const render = (app: App<any>): string => canonicalText(document(app));

function tagOf(schema: JsonObject, types: { readonly [name: string]: JsonObject }): string | undefined {
  const name = typeof schema.$ref === "string" ? REFERENCE.exec(schema.$ref)?.[1] : undefined;
  const resolved = name === undefined ? schema : types[name];
  const tag = (resolved?.properties as { readonly _tag?: JsonObject } | undefined)?._tag;
  if (tag === undefined) return undefined;
  if (typeof tag.const === "string") return tag.const;
  if (Array.isArray(tag.enum) && tag.enum.length === 1 && typeof tag.enum[0] === "string") return tag.enum[0];
  return undefined;
}

/**
 * Effect writes an empty `Schema.Struct({})` as "not null", because an empty TypeScript object type accepts almost
 * any value. A catalog input is always an object, so write it as one.
 */
function objectSchema(schema: JsonObject): JsonObject {
  const notNull = Object.keys(schema).length === 1 && JSON.stringify(schema.not) === JSON.stringify({ type: "null" });
  return notNull ? { type: "object" } : schema;
}
