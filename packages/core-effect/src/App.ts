/**
 * An application: its targets, its capabilities and its events. The application writes its own catalog, so the code is the
 * source and the catalog is checked at build time. See spec/catalog.md#build-time-and-run-time.
 */
import { canonicalText } from "@acid-cat/catalog";
import { objectInput, REFERENCE } from "@acid-cat/spec-ts";
import type { CatalogCapability, CatalogDocument, CatalogEvent, JsonObject } from "@acid-cat/spec-ts";
import { Predicate, Schema } from "effect";

import type * as Capability from "./Capability.ts";
import type * as Event from "./Event.ts";

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
  /** The events (spec/events.md). Capabilities and events share one set of ids. */
  readonly events?: readonly Event.Any<R>[] | undefined;
}

/** The services of all the capabilities and all the events of an application. */
export type Services<Capabilities extends readonly Capability.Any[], Events extends readonly Event.Any[]> =
  | Capability.Services<Capabilities[number]>
  | Event.Services<Events[number]>;

/** Declare an application. */
export const make = <const Capabilities extends readonly Capability.Any[], const Events extends readonly Event.Any[] = readonly []>(app: {
  readonly title?: string;
  readonly description?: string;
  readonly targets: { readonly [name: string]: Target };
  /** Each capability needs only the services of the application, so the intersection accepts the same values. */
  readonly capabilities: Capabilities & readonly Capability.Any<Services<Capabilities, Events>>[];
  /** Each event needs only the services of the application, so the intersection accepts the same values. */
  readonly events?: Events & readonly Event.Any<Services<Capabilities, Events>>[];
}): App<Services<Capabilities, Events>> => app;

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

  const events: Record<string, CatalogEvent> = {};
  for (const event of app.events ?? []) {
    if (event.id in capabilities) throw new Error(`The id ${event.id} is both a capability and an event.`);
    if (event.id in events) throw new Error(`The event ${event.id} is declared two times.`);
    const payload = event.payload === undefined ? undefined : toJson(event.payload, event.id);
    if (payload !== undefined && !isObjectSchema(payload, types)) throw new Error(`${event.id}: the payload must be an object, for example a Schema.Struct.`);
    events[event.id] = {
      description: event.description,
      audience: event.audience,
      ...(event.input === undefined ? {} : { input: objectInput(inputSchema(event.input, toJson(event.input, event.id)), types) }),
      ...(payload === undefined ? {} : { payload }),
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
    ...(Object.keys(events).length === 0 ? {} : { events }),
  };
}

/** `true` if a schema is an object: `"type": "object"`, or a reference to a type that is an object (spec/catalog.md#events). */
function isObjectSchema(schema: JsonObject, types: { readonly [name: string]: JsonObject }): boolean {
  const name = typeof schema.$ref === "string" ? REFERENCE.exec(schema.$ref)?.[1] : undefined;
  const resolved = name === undefined ? schema : types[name];
  return resolved?.type === "object";
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
