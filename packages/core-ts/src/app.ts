import { canonicalText } from "@acid-cat/catalog";
import { isJsonObject, objectInput } from "@acid-cat/spec-ts";
import type { Availability, CatalogCapability, CatalogDocument, CatalogEvent, Emitted, JsonObject, Result } from "@acid-cat/spec-ts";

import type { StandardSchemaV1 } from "./standard-schema.ts";

export interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: (value: T) => void): { unsubscribe(): void };
}

export type EmptyInput = Record<string, never>;

export type FailureData = { readonly [tag: string]: object };

export type FailureOf<Failures> = { [Tag in keyof Failures]: { readonly _tag: Tag } & Failures[Tag] }[keyof Failures];

/** The schema of a failure describes the object, without or with its `_tag`. */
export type FailureSchemas<Failures> = { readonly [Tag in keyof Failures]: StandardSchemaV1<unknown, Failures[Tag]> };

export interface Call<Context> {
  readonly signal: AbortSignal;
  readonly context: Context;
  /** The target of the session, for example `"mcp"` or `"cli"`. */
  readonly target: string;
}

export type Run<Context, Input, Value, Failures> = (
  input: Input,
  call: Call<Context>,
) => Promise<Result<NoInfer<Value>, NoInfer<FailureOf<Failures>>>> | Result<NoInfer<Value>, NoInfer<FailureOf<Failures>>>;

export interface CapabilityParts<Context, Value, Failures, State, Id extends string> {
  readonly id: Id;
  readonly description: string;
  /** The targets that can use the capability. With no audience, no target can use it. */
  readonly audience: readonly string[];
  readonly readOnly?: boolean | undefined;
  /** `true` when a call can delete or overwrite something that a client can see, `false` when a call only adds. */
  readonly destructive?: boolean | undefined;
  /** `true` when a second call with the same input has no further effect that a client can see. */
  readonly idempotent?: boolean | undefined;
  /** The value of a successful call. With no output schema, the value is `null`. */
  readonly output?: StandardSchemaV1<unknown, Value> | undefined;
  readonly failures?: FailureSchemas<Failures> | undefined;
  readonly state?: { readonly schema: StandardSchemaV1<unknown, State>; readonly source: (context: Context) => Observable<NoInfer<State>> } | undefined;
  /** The availability of the capability. With none, the capability is always available. */
  readonly availability?: ((context: Context) => Observable<Availability>) | undefined;
}

/**
 * A capability with an input schema: an object schema, or a union of object schemas. The catalog writes a union with
 * `"type": "object"`. `run` receives the output of the schema.
 */
export interface WithInput<Context, Input, Value, Failures, Encoded = unknown> {
  readonly input: StandardSchemaV1<Encoded, Input>;
  readonly run: Run<Context, Input, Value, Failures>;
}

export interface WithoutInput<Context, Value, Failures> {
  readonly input?: undefined;
  readonly run: Run<Context, EmptyInput, Value, Failures>;
}

export type CapabilityDeclaration<Context, Input, Value, Failures, State, Id extends string, Encoded = unknown> = CapabilityParts<Context, Value, Failures, State, Id> &
  (WithInput<Context, Input, Value, Failures, Encoded> | WithoutInput<Context, Value, Failures>);

export type Decoded<Context> =
  | { readonly issues: readonly StandardSchemaV1.Issue[] }
  | { readonly start: (call: Call<Context>) => Promise<Result<unknown, unknown>> | Result<unknown, unknown> };

export type Decode<Context> = (input: unknown) => Promise<Decoded<Context>>;

/** `Encoded` is the type that the input schema accepts: the JSON side of the input. */
export type Capability<Context = unknown, Input = EmptyInput, Value = null, Failures = {}, State = never, Id extends string = string, Encoded = unknown> = CapabilityDeclaration<
  Context,
  Input,
  Value,
  Failures,
  State,
  Id,
  Encoded
> & { readonly decode: Decode<Context> };

export interface AnyCapability<Context = never> {
  readonly id: string;
  readonly description: string;
  readonly audience: readonly string[];
  readonly readOnly?: boolean | undefined;
  readonly destructive?: boolean | undefined;
  readonly idempotent?: boolean | undefined;
  readonly input?: StandardSchemaV1 | undefined;
  readonly output?: StandardSchemaV1 | undefined;
  readonly failures?: { readonly [tag: string]: StandardSchemaV1 } | undefined;
  readonly state?: { readonly schema: StandardSchemaV1; readonly source: (context: Context) => Observable<unknown> } | undefined;
  readonly availability?: ((context: Context) => Observable<Availability>) | undefined;
  readonly decode: Decode<Context>;
}

/**
 * Declare a capability. `Context` is the type of the services that `run` receives. The other types come from the
 * schemas, and the id keeps its literal type. With an input schema, `run` receives the output of the schema. With
 * none, it receives an empty object.
 */
export function defineCapability<
  Context = unknown,
  Input = EmptyInput,
  Value = null,
  Failures extends FailureData = {},
  State = never,
  const Id extends string = string,
  Encoded = unknown,
>(
  declaration: CapabilityParts<Context, Value, Failures, State, Id> & WithInput<Context, Input, Value, Failures, Encoded>,
): Capability<Context, Input, Value, Failures, State, Id, Encoded>;
export function defineCapability<Context = unknown, Value = null, Failures extends FailureData = {}, State = never, const Id extends string = string>(
  declaration: CapabilityParts<Context, Value, Failures, State, Id> & WithoutInput<Context, Value, Failures>,
): Capability<Context, EmptyInput, Value, Failures, State, Id, never>;
// TypeScript gives `run` no contextual type from a union of the two signatures above, so they are separate overloads.
export function defineCapability<Context, Input, Value, Failures, State, Id extends string>(
  declaration: CapabilityDeclaration<Context, Input, Value, Failures, State, Id>,
): Capability<Context, Input, Value, Failures, State, Id> {
  return { ...declaration, decode: decoderOf(declaration) };
}

function decoderOf<Context, Input, Value, Failures, State, Id extends string>(
  declaration: CapabilityDeclaration<Context, Input, Value, Failures, State, Id>,
): Decode<Context> {
  if (declaration.input === undefined) {
    const { run } = declaration;
    return () => Promise.resolve({ start: (call) => run({}, call) });
  }
  const { input: schema, run } = declaration;
  return async (input) => {
    const validated = await schema["~standard"].validate(input);
    if (validated.issues !== undefined) return { issues: validated.issues };
    const { value } = validated;
    return { start: (call) => run(value, call) };
  };
}

export interface CapabilityFactory<Context> {
  <Input, Value = null, Failures extends FailureData = {}, State = never, const Id extends string = string, Encoded = unknown>(
    declaration: CapabilityParts<Context, Value, Failures, State, Id> & WithInput<Context, Input, Value, Failures, Encoded>,
  ): Capability<Context, Input, Value, Failures, State, Id, Encoded>;
  <Value = null, Failures extends FailureData = {}, State = never, const Id extends string = string>(
    declaration: CapabilityParts<Context, Value, Failures, State, Id> & WithoutInput<Context, Value, Failures>,
  ): Capability<Context, EmptyInput, Value, Failures, State, Id, never>;
}

/**
 * Declare capabilities for one context type. The other types come from the schemas:
 *
 * ```ts
 * const capability = capabilitiesFor<{ unit: Unit }>();
 * capability({ id: "aircon.power.set", input: z.object({ on: z.boolean() }), run: ({ on }, { context }) => … });
 * ```
 */
export const capabilitiesFor = <Context>(): CapabilityFactory<Context> => defineCapability;

/** The signal aborts when the subscription ends, in all ways. */
export interface Subscription<Context> {
  readonly signal: AbortSignal;
  readonly context: Context;
  /** The target of the session, for example `"mcp"` or `"cli"`. */
  readonly target: string;
  /** The cursor of the client. With none, the subscription starts now. */
  readonly cursor?: string | undefined;
  /** The client wants no occurrence that is older than this number of milliseconds. */
  readonly maxAgeMs?: number | undefined;
}

/**
 * The function of an event. It gives one value for each occurrence, in order, until the signal aborts or the source
 * has no more occurrences. Each `data` must agree with the payload schema.
 */
export type Subscribe<Context, Input, Payload> = (input: Input, subscription: Subscription<Context>) => AsyncIterable<Emitted<NoInfer<Payload>>>;

export interface EventParts<Payload, Id extends string> {
  readonly id: Id;
  readonly description: string;
  /** The targets that can use the event. With no audience, no target can use it. */
  readonly audience: readonly string[];
  /** The schema of the `data` of each occurrence: an object schema. With no payload schema, the data is an empty object. */
  readonly payload?: StandardSchemaV1<unknown, Payload> | undefined;
}

export interface EventWithInput<Context, Input, Payload, Encoded = unknown> {
  readonly input: StandardSchemaV1<Encoded, Input>;
  readonly subscribe: Subscribe<Context, Input, Payload>;
}

export interface EventWithoutInput<Context, Payload> {
  readonly input?: undefined;
  readonly subscribe: Subscribe<Context, EmptyInput, Payload>;
}

export type EventDeclaration<Context, Input, Payload, Id extends string, Encoded = unknown> = EventParts<Payload, Id> &
  (EventWithInput<Context, Input, Payload, Encoded> | EventWithoutInput<Context, Payload>);

export type DecodedEvent<Context> =
  | { readonly issues: readonly StandardSchemaV1.Issue[] }
  | { readonly start: (subscription: Subscription<Context>) => AsyncIterable<Emitted<unknown>> };

/** `Encoded` is the type that the input schema accepts: the JSON side of the input. */
export type EventDefinition<Context = unknown, Input = EmptyInput, Payload = EmptyInput, Id extends string = string, Encoded = unknown> = EventDeclaration<
  Context,
  Input,
  Payload,
  Id,
  Encoded
> & {
  readonly decode: (input: unknown) => Promise<DecodedEvent<Context>>;
};

export interface AnyEventDefinition<Context = never> {
  readonly id: string;
  readonly description: string;
  readonly audience: readonly string[];
  readonly input?: StandardSchemaV1 | undefined;
  readonly payload?: StandardSchemaV1 | undefined;
  readonly decode: (input: unknown) => Promise<DecodedEvent<Context>>;
}

/**
 * Declare an event. `Context` is the type of the services that `subscribe` receives. The other types come from the
 * schemas, and the id keeps its literal type.
 */
export function defineEvent<Context = unknown, Input = EmptyInput, Payload = EmptyInput, const Id extends string = string, Encoded = unknown>(
  declaration: EventParts<Payload, Id> & EventWithInput<Context, Input, Payload, Encoded>,
): EventDefinition<Context, Input, Payload, Id, Encoded>;
export function defineEvent<Context = unknown, Payload = EmptyInput, const Id extends string = string>(
  declaration: EventParts<Payload, Id> & EventWithoutInput<Context, Payload>,
): EventDefinition<Context, EmptyInput, Payload, Id, never>;
// TypeScript gives `subscribe` no contextual type from a union of the two signatures above, so they are separate overloads.
export function defineEvent<Context, Input, Payload, Id extends string>(
  declaration: EventDeclaration<Context, Input, Payload, Id>,
): EventDefinition<Context, Input, Payload, Id> {
  if (declaration.input === undefined) {
    const { subscribe } = declaration;
    return { ...declaration, decode: () => Promise.resolve({ start: (subscription) => subscribe({}, subscription) }) };
  }
  const { input: schema, subscribe } = declaration;
  return {
    ...declaration,
    decode: async (input) => {
      const validated = await schema["~standard"].validate(input);
      if (validated.issues !== undefined) return { issues: validated.issues };
      const { value } = validated;
      return { start: (subscription) => subscribe(value, subscription) };
    },
  };
}

export interface EventFactory<Context> {
  <Input, Payload = EmptyInput, const Id extends string = string, Encoded = unknown>(
    declaration: EventParts<Payload, Id> & EventWithInput<Context, Input, Payload, Encoded>,
  ): EventDefinition<Context, Input, Payload, Id, Encoded>;
  <Payload = EmptyInput, const Id extends string = string>(declaration: EventParts<Payload, Id> & EventWithoutInput<Context, Payload>): EventDefinition<Context, EmptyInput, Payload, Id, never>;
}

export const eventsFor = <Context>(): EventFactory<Context> => defineEvent;

/** An alias of the command line (spec/bindings/cli.md#aliases). Make it with `cliAlias` or `cliAliasDefault`. */
export interface CliAlias {
  readonly member: "capability" | "event";
  readonly id: string;
  readonly input?: JsonObject | undefined;
  readonly isDefault: boolean;
}

type Aliased<Encoded> = { readonly id: string; readonly input?: StandardSchemaV1<Encoded, unknown> | undefined } & ({ readonly run: unknown } | { readonly subscribe: unknown });

const aliasOf = <Encoded>(of: Aliased<Encoded>, input: Partial<Encoded> | undefined, isDefault: boolean): CliAlias => {
  if (input !== undefined && !isJsonObject(input)) throw new Error(`The fixed input of an alias of ${of.id} must be a JSON object.`);
  return { member: "run" in of ? "capability" : "event", id: of.id, ...(input === undefined ? {} : { input }), isDefault };
};

/** An alias of a capability or an event. The fixed input has some properties of the input, in the form that the input schema accepts. */
export const cliAlias = <Encoded>(of: Aliased<Encoded>, input?: NoInfer<Partial<Encoded>>): CliAlias => aliasOf(of, input, false);

/** The alias that runs when the program gets no arguments. It must be a command alias, and a target has one at most. */
export const cliAliasDefault = <Encoded>(of: Aliased<Encoded>, input?: NoInfer<Partial<Encoded>>): CliAlias => aliasOf(of, input, true);

export interface Target {
  readonly bindings: readonly string[];
  readonly description?: string | undefined;
  readonly options?: JsonObject | undefined;
  /** The aliases of the command line. The catalog writes them in `options.cli`. */
  readonly cli?: { readonly aliases: { readonly [name: string]: CliAlias } } | undefined;
}

export interface App<Context = unknown> {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly targets: { readonly [name: string]: Target };
  readonly capabilities: readonly AnyCapability<Context>[];
  /** Capabilities and events share one set of ids. */
  readonly events?: readonly AnyEventDefinition<Context>[] | undefined;
}

export const defineApp = <Context = unknown>(app: App<Context>): App<Context> => app;

/** Converts a schema to JSON Schema 2020-12, for example `(schema) => z.toJSONSchema(schema)` with Zod. */
export type ToJsonSchema = (schema: StandardSchemaV1) => JsonObject;

const catalogs = new WeakMap<App<never>, WeakMap<ToJsonSchema, CatalogDocument>>();

/**
 * The catalog of an application, as a JSON document. The catalog is written one time for each application and
 * `toJsonSchema`. Later calls with the same two give the same document.
 */
export function catalogOf(app: App<never>, options: { readonly toJsonSchema: ToJsonSchema }): CatalogDocument {
  let byConverter = catalogs.get(app);
  if (byConverter === undefined) {
    byConverter = new WeakMap();
    catalogs.set(app, byConverter);
  }
  let written = byConverter.get(options.toJsonSchema);
  if (written === undefined) {
    written = write(app, options.toJsonSchema);
    byConverter.set(options.toJsonSchema, written);
  }
  return written;
}

function write(app: App<never>, toJsonSchema: ToJsonSchema): CatalogDocument {
  const types: Record<string, JsonObject> = {};

  const toJson = (schema: StandardSchemaV1, where: string): JsonObject => {
    const { $schema: _, $defs, ...json } = toJsonSchema(schema);
    for (const [name, definition] of Object.entries(isJsonObject($defs) ? $defs : {})) {
      if (!isJsonObject(definition)) throw new Error(`${where}: the schema ${name} is not an object. Give each named schema as an object.`);
      const existing = types[name];
      if (existing !== undefined && JSON.stringify(existing) !== JSON.stringify(definition)) {
        throw new Error(`${where}: two different schemas have the name ${name}. Give each one its own name.`);
      }
      types[name] = definition;
    }
    return json;
  };

  const capabilities: Record<string, CatalogCapability> = {};
  for (const capability of app.capabilities) {
    if (capability.id in capabilities) throw new Error(`The capability ${capability.id} is declared two times.`);
    const failures = Object.fromEntries(
      Object.entries(capability.failures ?? {}).map(([tag, schema]) => [tag, toJson(schema, capability.id)]),
    );
    capabilities[capability.id] = {
      description: capability.description,
      audience: capability.audience,
      ...(capability.input === undefined ? {} : { input: objectInput(toJson(capability.input, capability.id), types) }),
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
    if (event.id in capabilities || event.id in events) throw new Error(`The id ${event.id} is declared two times.`);
    events[event.id] = {
      description: event.description,
      audience: event.audience,
      ...(event.input === undefined ? {} : { input: objectInput(toJson(event.input, event.id), types) }),
      ...(event.payload === undefined ? {} : { payload: objectInput(toJson(event.payload, event.id), types) }),
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

/** The catalog of an application, as text in canonical form. */
export const renderCatalog = (app: App<never>, options: { readonly toJsonSchema: ToJsonSchema }): string =>
  canonicalText(catalogOf(app, options));
