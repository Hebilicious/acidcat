import { canonicalText } from "@acid-cat/catalog";
import { isJsonObject, objectInput, REFERENCE } from "@acid-cat/spec-ts";
import type { CatalogCapability, CatalogDocument, CatalogEvent, JsonObject } from "@acid-cat/spec-ts";
import { Predicate, Schema } from "effect";

import type * as Capability from "./Capability.ts";
import type { AnySchema } from "./Capability.ts";
import type * as Event from "./Event.ts";
import type { Ui } from "./internal/human.ts";

/** An alias of the command line (spec/bindings/cli.md#aliases). Make it with `App.alias` or `App.aliasDefault`. */
export interface Alias {
  readonly member: "capability" | "event";
  readonly id: string;
  readonly input?: JsonObject | undefined;
  readonly isDefault: boolean;
}

type Aliased<Input extends AnySchema> = { readonly id: string; readonly input?: Input | undefined } & ({ readonly run: unknown } | { readonly subscribe: unknown });

const aliasOf = <Input extends AnySchema>(of: Aliased<Input>, input: Partial<Input["Encoded"]> | undefined, isDefault: boolean): Alias => {
  if (input !== undefined && !isJsonObject(input)) throw new Error(`The fixed input of an alias of ${of.id} must be a JSON object.`);
  return { member: "run" in of ? "capability" : "event", id: of.id, ...(input === undefined ? {} : { input }), isDefault };
};

/** An alias of a capability or an event. The fixed input has some properties of the input, in the encoded form of the input schema. */
export const alias = <Input extends AnySchema>(of: Aliased<Input>, input?: NoInfer<Partial<Input["Encoded"]>>): Alias => aliasOf(of, input, false);

/** The alias that runs when the program gets no arguments. It must be a command alias, and a target has one at most. */
export const aliasDefault = <Input extends AnySchema>(of: Aliased<Input>, input?: NoInfer<Partial<Input["Encoded"]>>): Alias => aliasOf(of, input, true);

/**
 * How the command line writes the outcomes of a capability, or the occurrences of an event, for a person. Make it with
 * `App.format`, and give it in the `formats` of the command line.
 */
export interface Format {
  readonly member: "capability" | "event";
  readonly id: string;
  /** The output schema of the capability, or the payload schema of the event. */
  readonly schema?: AnySchema | undefined;
  /** The formatter of the value of the capability, or of the payload of the event. */
  readonly value?: ((value: unknown, ui: Ui) => string) | undefined;
  readonly failureSchemas?: readonly AnySchema[] | undefined;
  readonly failures?: { readonly [tag: string]: ((failure: unknown, ui: Ui) => string) | undefined } | undefined;
}

type Tag<Failure> = Failure extends { readonly _tag: infer T extends string } ? T : never;

export interface CapabilityFormats<Value, Failure> {
  readonly value?: ((value: Value, ui: Ui) => string) | undefined;
  readonly failures?:
    | ([Tag<Failure>] extends [never] ? never : { readonly [T in Tag<Failure>]?: (failure: Extract<Failure, { readonly _tag: T }>, ui: Ui) => string })
    | undefined;
}

type Formatted<Output extends AnySchema, Failure extends AnySchema> = {
  readonly id: string;
  readonly output?: Output | undefined;
  readonly failures?: readonly Failure[] | undefined;
  readonly run: unknown;
};

type FormattedEvent<Payload extends AnySchema> = { readonly id: string; readonly payload?: Payload | undefined; readonly subscribe: unknown };

type AnyFormats = ((value: unknown, ui: Ui) => string) | CapabilityFormats<unknown, unknown> | { readonly failures?: Format["failures"] };

/**
 * The formatters of a capability for the command line. Each one gets its value in the `Type` form of its schema: the
 * command line decodes the JSON form with the output schema, or with the failure schemas, before it calls the
 * formatter. A function alone is the formatter of the value.
 */
export function format<Output extends AnySchema, Failure extends AnySchema>(
  capability: Formatted<Output, Failure>,
  formats: CapabilityFormats<Output["Type"], Failure["Type"]> | ((value: Output["Type"], ui: Ui) => string),
): Format;
export function format<Payload extends AnySchema>(event: FormattedEvent<Payload>, payload: (payload: Payload["Type"], ui: Ui) => string): Format;
export function format(of: Formatted<AnySchema, AnySchema> | FormattedEvent<AnySchema>, formats: AnyFormats): Format {
  if ("subscribe" in of) {
    if (typeof formats !== "function") throw new Error(`The format of the event ${of.id} must be a function of its payload.`);
    return { member: "event", id: of.id, schema: of.payload, value: formats };
  }
  const { value, failures } = typeof formats === "function" ? { value: formats, failures: undefined } : { value: undefined, ...formats };
  const tags = (of.failures ?? []).map(failureTag);
  for (const tag of Object.keys(failures ?? {})) {
    if (!tags.includes(tag)) throw new Error(`The capability ${of.id} has no failure ${tag}.`);
  }
  return { member: "capability", id: of.id, schema: of.output, value, failureSchemas: of.failures, failures };
}

export interface Target {
  /** The bindings that serve the target, for example `["mcp"]`. */
  readonly bindings: readonly string[];
  readonly description?: string | undefined;
  readonly options?: JsonObject | undefined;
  /** The aliases of the command line. The catalog writes them in `options.cli`. */
  readonly cli?: { readonly aliases: { readonly [name: string]: Alias } } | undefined;
}

export interface App<R = never> {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly targets: { readonly [name: string]: Target };
  readonly capabilities: readonly Capability.Any<R>[];
  /** The events (spec/events.md). Capabilities and events share one set of ids. */
  readonly events?: readonly Event.Any<R>[] | undefined;
}

export type Services<Capabilities extends readonly Capability.Any[], Events extends readonly Event.Any[]> =
  | Capability.Services<Capabilities[number]>
  | Event.Services<Events[number]>;

type EachNeedsOnly<Members extends readonly unknown[], Member> = Members & readonly Member[];

export const make = <const Capabilities extends readonly Capability.Any[], const Events extends readonly Event.Any[] = readonly []>(app: {
  readonly title?: string;
  readonly description?: string;
  readonly targets: { readonly [name: string]: Target };
  readonly capabilities: EachNeedsOnly<Capabilities, Capability.Any<Services<Capabilities, Events>>>;
  readonly events?: EachNeedsOnly<Events, Event.Any<Services<Capabilities, Events>>>;
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
    const { schema: json, definitions } = Schema.toJsonSchemaDocument(schema, { includeAnnotationKey: isExtensionMember });
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
      ...(capability.destructive === undefined ? {} : { destructive: capability.destructive }),
      ...(capability.idempotent === undefined ? {} : { idempotent: capability.idempotent }),
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
          ...optionsOf(name, target),
        },
      ]),
    ),
    ...(Object.keys(types).length === 0 ? {} : { $defs: types }),
    capabilities,
    ...(Object.keys(events).length === 0 ? {} : { events }),
  };
}

function optionsOf(name: string, target: Target): { readonly options?: JsonObject } {
  if (target.cli === undefined) return target.options === undefined ? {} : { options: target.options };
  if (target.options?.cli !== undefined) throw new Error(`Target ${name}: give the aliases in cli or in options.cli, not in both.`);
  const aliases: Record<string, JsonObject> = {};
  const defaults: string[] = [];
  for (const [alias, { member, id, input, isDefault }] of Object.entries(target.cli.aliases)) {
    aliases[alias] = { [member]: id, ...(input === undefined ? {} : { input }) };
    if (isDefault) defaults.push(alias);
  }
  const [defaultAlias, ...others] = defaults;
  if (others.length > 0) throw new Error(`Target ${name}: the aliases ${defaults.join(", ")} are all default aliases. Give one at most.`);
  if (defaultAlias?.startsWith("--") === true) throw new Error(`Target ${name}: the default alias ${defaultAlias} is a flag alias. Make it a command alias.`);
  return { options: { ...target.options, cli: { aliases, ...(defaultAlias === undefined ? {} : { default: defaultAlias }) } } };
}

function isObjectSchema(schema: JsonObject, types: { readonly [name: string]: JsonObject }): boolean {
  const name = typeof schema.$ref === "string" ? REFERENCE.exec(schema.$ref)?.[1] : undefined;
  const resolved = name === undefined ? schema : types[name];
  return resolved?.type === "object";
}

const isExtensionMember = (key: string): boolean => key.startsWith("x-");

/** The catalog of an application, as text in canonical form. */
export const render = (app: App<unknown>): string => canonicalText(document(app));

function failureTag(failure: Schema.Top): string | undefined {
  const { schema, definitions } = Schema.toJsonSchemaDocument(failure);
  return tagOf(schema, definitions);
}

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
 * so it gets an empty `properties` (spec/catalog.md#capabilities).
 */
function inputSchema(input: Schema.Top, json: JsonObject): JsonObject {
  const notNull = Object.keys(json).length === 1 && JSON.stringify(json.not) === JSON.stringify({ type: "null" });
  if (!notNull) return json;
  const fields = "fields" in input ? input.fields : undefined;
  return Predicate.isReadonlyObject(fields) && Object.keys(fields).length === 0 ? { type: "object", properties: {} } : { type: "object" };
}
