/**
 * An application: its targets and its capabilities. The application writes its own catalog, so the code is the
 * source and the catalog is checked at build time. See spec/catalog.md#build-time-and-run-time.
 */
import { canonicalText } from "@acid-cat/catalog";
import { objectInput, REFERENCE } from "@acid-cat/spec-ts";
import type { CatalogCapability, CatalogDocument, JsonObject } from "@acid-cat/spec-ts";
import { Predicate, Schema } from "effect";

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
  /** Each capability needs only the services of all the capabilities, so the intersection accepts the same values. */
  readonly capabilities: Capabilities & readonly Capability.Any<Capability.Services<Capabilities[number]>>[];
}): App<Capability.Services<Capabilities[number]>> => app;

const documents = new WeakMap<App<unknown>, CatalogDocument>();

/**
 * The catalog of an application, as a JSON document. The document is written one time for each application. Later
 * calls give the same document.
 */
export function document(app: App<unknown>): CatalogDocument {
  let written = documents.get(app);
  if (written === undefined) {
    written = write(app);
    documents.set(app, written);
  }
  return written;
}

function write(app: App<unknown>): CatalogDocument {
  const types: Record<string, JsonObject> = {};

  const toJson = (schema: Schema.Top, where: string): JsonObject => {
    const { schema: json, definitions } = Schema.toJsonSchemaDocument(schema);
    for (const [name, definition] of Object.entries(definitions)) {
      const existing = types[name];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(definition)) {
        throw new Error(`${where}: two different schemas have the identifier ${name}. Give each one its own identifier.`);
      }
      types[name] = definition;
    }
    return json;
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
      ...(capability.input === undefined
        ? {}
        : { input: objectInput(inputSchema(capability.input, toJson(capability.input, capability.id)), types) }),
      ...(capability.output === undefined ? {} : { output: toJson(capability.output, capability.id) }),
      ...(Object.keys(failures).length === 0 ? {} : { failures }),
      ...(capability.readOnly === true ? { readOnly: true } : {}),
      ...(capability.state === undefined ? {} : { state: toJson(capability.state.schema, capability.id) }),
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
export const render = (app: App<unknown>): string => canonicalText(document(app));

function tagOf(schema: JsonObject, types: { readonly [name: string]: JsonObject }): string | undefined {
  const name = typeof schema.$ref === "string" ? REFERENCE.exec(schema.$ref)?.[1] : undefined;
  const resolved = name === undefined ? schema : types[name];
  const properties = resolved?.properties;
  const tag = Predicate.isReadonlyObject(properties) ? properties._tag : undefined;
  if (!Predicate.isReadonlyObject(tag)) return undefined;
  if (typeof tag.const === "string") return tag.const;
  if (Array.isArray(tag.enum) && tag.enum.length === 1 && typeof tag.enum[0] === "string") return tag.enum[0];
  return undefined;
}

/**
 * Effect writes an empty `Schema.Struct({})` as "not null", because an empty TypeScript object type accepts almost
 * any value. A catalog input is always an object, so write it as one. An empty struct is an input with no properties,
 * so it gets an empty `properties` (spec/catalog.md#capabilities). Other schemas that Effect writes as "not null"
 * take any object.
 */
function inputSchema(input: Schema.Top, json: JsonObject): JsonObject {
  const notNull = Object.keys(json).length === 1 && JSON.stringify(json.not) === JSON.stringify({ type: "null" });
  if (!notNull) return json;
  const fields = "fields" in input ? input.fields : undefined;
  return Predicate.isReadonlyObject(fields) && Object.keys(fields).length === 0 ? { type: "object", properties: {} } : { type: "object" };
}
