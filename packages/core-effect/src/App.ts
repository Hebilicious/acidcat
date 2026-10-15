/**
 * An application: its targets and its capabilities. The application writes its own catalog, so the code is the
 * source and the catalog is checked at build time. See spec/catalog.md#build-time-and-run-time.
 */
import { canonicalText } from "@acid-cat/catalog";
import { bundle, REFERENCE, viewOf } from "@acid-cat/spec-ts";
import type { CatalogCapability, CatalogDocument, JsonObject } from "@acid-cat/spec-ts";
import { Effect, Schema } from "effect";

import * as Capability from "./Capability.ts";
import { declarationOf } from "./internal/declarations.ts";

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

/**
 * The capability with its schemas. A lazy capability must have loaded: `load` loads the lazy capabilities of an
 * application.
 */
export function withSchemas(capability: Capability.Any): Capability.Capability<any, any, any, any> {
  const loaded = Capability.loadedNow(capability);
  if (loaded === undefined) {
    throw new Error(`The capability ${capability.id} is lazy, and has not loaded. Load the lazy capabilities with App.load(app) first.`);
  }
  return loaded;
}

/**
 * Load the lazy capabilities of an application, so that `document`, `render` and `Cli.command` can write their schemas.
 * With a target, load only the capabilities that the target can use. A load that fails is `Capability.LoadFailed`.
 */
export const load = (app: App<any>, options: { readonly target?: string | undefined } = {}): Effect.Effect<void, Capability.LoadFailed> =>
  Effect.forEach(options.target === undefined ? app.capabilities : capabilitiesOf(app, options.target), Capability.load, {
    concurrency: "unbounded",
    discard: true,
  });

/** The catalog of an application, as a JSON document. A lazy capability must have loaded (see `load`). */
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
  for (const capability of app.capabilities.map(withSchemas)) {
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
      ...(capability.input === undefined ? {} : { input: inputSchema(capability.input, toJson(capability.input, capability.id)) }),
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
export const render = (app: App<any>): string => canonicalText(document(app));

const views = new WeakMap<App<any>, Map<string, CatalogDocument>>();

/**
 * The view of a target (spec/catalog.md#views). It is written from the capabilities of the target the first time that
 * it is asked for, then kept for the application. The lazy capabilities of the target must have loaded: see `load`
 * with a target. It checks the identifiers of the schemas of its target only: `render` of the whole application, at
 * build time, checks all of them.
 */
export function view(app: App<any>, target: string): CatalogDocument {
  let byTarget = views.get(app);
  if (byTarget === undefined) {
    byTarget = new Map();
    views.set(app, byTarget);
  }
  let written = byTarget.get(target);
  if (written === undefined) {
    // Only the capabilities of the target: a lazy capability of another target need not have loaded.
    written = viewOf(document({ ...app, capabilities: capabilitiesOf(app, target) }), target);
    byTarget.set(target, written);
  }
  return written;
}

/** The capabilities of an application that a target can use, in the order of the application. */
export const capabilitiesOf = <R>(app: App<R>, target: string): readonly Capability.Any<R>[] =>
  app.capabilities.filter((capability) => capability.audience.includes(target));

interface Rendered {
  input?: JsonObject;
  output?: JsonObject | undefined;
}

const rendered = new WeakMap<Capability.Any, Rendered>();

/** The schemas that a capability has written. A lazy capability and the capability that it loaded share one entry. */
const renderedOf = (capability: Capability.Any): Rendered => {
  const key = declarationOf(capability) as Capability.Any;
  let entry = rendered.get(key);
  if (entry === undefined) {
    entry = {};
    rendered.set(key, entry);
  }
  return entry;
};

/** A schema as JSON Schema, bundled with the types that it uses (spec/catalog.md#bundling). */
function bundled(schema: Schema.Top, json: (schema: JsonObject) => JsonObject = (same) => same): JsonObject {
  const { schema: written, definitions } = Schema.toJsonSchemaDocument(schema);
  return bundle(json(written as JsonObject), definitions as { readonly [name: string]: JsonObject });
}

/**
 * The input schema of a capability as bundled JSON Schema, as the view of a target has it. A capability with no input
 * schema takes an empty object. The schema is written the first time that a binding asks for it, then kept.
 */
export function inputJsonSchema(declared: Capability.Any): JsonObject {
  const entry = renderedOf(declared);
  if (entry.input === undefined) {
    const capability = withSchemas(declared);
    entry.input = capability.input === undefined ? { type: "object" } : bundled(capability.input, (json) => inputSchema(capability.input!, json));
  }
  return entry.input;
}

/**
 * The output schema of a capability as bundled JSON Schema, or `undefined` for a capability with no output schema. The
 * schema is written the first time that a binding asks for it, then kept.
 */
export function outputJsonSchema(declared: Capability.Any): JsonObject | undefined {
  const entry = renderedOf(declared);
  if (!("output" in entry)) {
    const capability = withSchemas(declared);
    entry.output = capability.output === undefined ? undefined : bundled(capability.output);
  }
  return entry.output;
}

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
 * any value. A catalog input is always an object, so write it as one. An empty struct is an input with no properties,
 * so it gets an empty `properties` (spec/catalog.md#capabilities). Other schemas that Effect writes as "not null"
 * take any object.
 */
function inputSchema(input: Schema.Top, json: JsonObject): JsonObject {
  const notNull = Object.keys(json).length === 1 && JSON.stringify(json.not) === JSON.stringify({ type: "null" });
  if (!notNull) return json;
  const fields = "fields" in input ? (input.fields as object) : undefined;
  return fields !== undefined && Object.keys(fields).length === 0 ? { type: "object", properties: {} } : { type: "object" };
}
