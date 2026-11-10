/**
 * Capabilities and applications in plain TypeScript. An application writes its own catalog.
 * See spec/catalog.md.
 */
import { canonicalText } from "@acid-cat/catalog";
import { isJsonObject, objectInput } from "@acid-cat/spec-ts";
import type { Availability, CatalogCapability, CatalogDocument, CatalogEvent, Emitted, JsonObject, Result } from "@acid-cat/spec-ts";

import type { StandardSchemaV1 } from "./standard-schema.ts";

/** A value that can change, and that a client can follow (spec/bindings/typescript.md#handles). */
export interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: (value: T) => void): { unsubscribe(): void };
}

/** The input of a capability that has no input schema: an empty object. */
export type EmptyInput = Record<string, never>;

/** The data of each failure, by tag: the output of its schema. */
export type FailureData = { readonly [tag: string]: object };

/** The failures of a capability, each with its `_tag`. */
export type FailureOf<Failures> = { [Tag in keyof Failures]: { readonly _tag: Tag } & Failures[Tag] }[keyof Failures];

/** The failure schemas of a capability, by tag. The schema of a failure describes the object, without or with its `_tag`. */
export type FailureSchemas<Failures> = { readonly [Tag in keyof Failures]: StandardSchemaV1<unknown, Failures[Tag]> };

/** What `run` receives beside the input: the signal of the call, and the context. */
export interface Call<Context> {
  readonly signal: AbortSignal;
  readonly context: Context;
}

/** The function of a capability. Its result has the types of the output schema and of the failure schemas. */
export type Run<Context, Input, Value, Failures> = (
  input: Input,
  call: Call<Context>,
) => Promise<Result<NoInfer<Value>, NoInfer<FailureOf<Failures>>>> | Result<NoInfer<Value>, NoInfer<FailureOf<Failures>>>;

/** The members of a capability that do not depend on its input. */
export interface CapabilityParts<Context, Value, Failures, State, Id extends string> {
  readonly id: Id;
  readonly description: string;
  /** The targets that can use the capability. With no audience, no target can use it. */
  readonly audience: readonly string[];
  readonly readOnly?: boolean | undefined;
  /** The value of a successful call. With no output schema, the value is `null`. */
  readonly output?: StandardSchemaV1<unknown, Value> | undefined;
  /** The failures, by tag. */
  readonly failures?: FailureSchemas<Failures> | undefined;
  /** A value that clients can observe (spec/invocation.md#state): its schema, and its source. */
  readonly state?: { readonly schema: StandardSchemaV1<unknown, State>; readonly source: (context: Context) => Observable<NoInfer<State>> } | undefined;
  /** The availability of the capability. With none, the capability is always available. */
  readonly availability?: ((context: Context) => Observable<Availability>) | undefined;
}

/**
 * A capability with an input schema: an object schema, or a union of object schemas. The catalog writes a union with
 * `"type": "object"`. `run` receives the output of the schema.
 */
export interface WithInput<Context, Input, Value, Failures> {
  readonly input: StandardSchemaV1<unknown, Input>;
  readonly run: Run<Context, Input, Value, Failures>;
}

/** A capability with no input schema. `run` receives an empty object. */
export interface WithoutInput<Context, Value, Failures> {
  readonly input?: undefined;
  readonly run: Run<Context, EmptyInput, Value, Failures>;
}

/**
 * A capability as an application declares it. `Context` is the type of the services that `run` receives. `Input`,
 * `Value`, `Failures` and `State` are the outputs of its schemas.
 */
export type CapabilityDeclaration<Context, Input, Value, Failures, State, Id extends string> = CapabilityParts<Context, Value, Failures, State, Id> &
  (WithInput<Context, Input, Value, Failures> | WithoutInput<Context, Value, Failures>);

/** The result of `decode`: the issues of an input that is not valid, or the call of `run` with the decoded input. */
export type Decoded<Context> =
  | { readonly issues: readonly StandardSchemaV1.Issue[] }
  | { readonly start: (call: Call<Context>) => Promise<Result<unknown, unknown>> | Result<unknown, unknown> };

/** Decode an input that is not trusted with the input schema of a capability. */
export type Decode<Context> = (input: unknown) => Promise<Decoded<Context>>;

/**
 * A capability that `defineCapability` or `capabilitiesFor` made: its declaration, and `decode`. A session calls
 * `decode` for an input that is not trusted, because the type of the input is not known there.
 */
export type Capability<Context = unknown, Input = EmptyInput, Value = null, Failures = {}, State = never, Id extends string = string> = CapabilityDeclaration<
  Context,
  Input,
  Value,
  Failures,
  State,
  Id
> & { readonly decode: Decode<Context> };

/** Any capability whose services the context `Context` gives, whatever its schemas are. */
export interface AnyCapability<Context = never> {
  readonly id: string;
  readonly description: string;
  readonly audience: readonly string[];
  readonly readOnly?: boolean | undefined;
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
>(declaration: CapabilityParts<Context, Value, Failures, State, Id> & WithInput<Context, Input, Value, Failures>): Capability<Context, Input, Value, Failures, State, Id>;
export function defineCapability<Context = unknown, Value = null, Failures extends FailureData = {}, State = never, const Id extends string = string>(
  declaration: CapabilityParts<Context, Value, Failures, State, Id> & WithoutInput<Context, Value, Failures>,
): Capability<Context, EmptyInput, Value, Failures, State, Id>;
// The two signatures above are the two members of `CapabilityDeclaration`. They exist so that `run` gets the type of
// its input from `input`: a union of the two does not give a contextual type to `run`.
export function defineCapability<Context, Input, Value, Failures, State, Id extends string>(
  declaration: CapabilityDeclaration<Context, Input, Value, Failures, State, Id>,
): Capability<Context, Input, Value, Failures, State, Id> {
  return { ...declaration, decode: decoderOf(declaration) };
}

/** The `decode` of a capability: validate the input with the input schema, then give the call of `run`. */
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

/** The function that `capabilitiesFor` gives: `defineCapability`, with one context type. */
export interface CapabilityFactory<Context> {
  <Input, Value = null, Failures extends FailureData = {}, State = never, const Id extends string = string>(
    declaration: CapabilityParts<Context, Value, Failures, State, Id> & WithInput<Context, Input, Value, Failures>,
  ): Capability<Context, Input, Value, Failures, State, Id>;
  <Value = null, Failures extends FailureData = {}, State = never, const Id extends string = string>(
    declaration: CapabilityParts<Context, Value, Failures, State, Id> & WithoutInput<Context, Value, Failures>,
  ): Capability<Context, EmptyInput, Value, Failures, State, Id>;
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

/**
 * What `subscribe` receives beside the input: the signal of the subscription, the context, and where the subscription
 * starts (spec/events.md#resuming). The signal aborts when the subscription ends, in all ways.
 */
export interface Subscription<Context> {
  readonly signal: AbortSignal;
  readonly context: Context;
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

/** The members of an event that do not depend on its input. */
export interface EventParts<Payload, Id extends string> {
  readonly id: Id;
  readonly description: string;
  /** The targets that can use the event. With no audience, no target can use it. */
  readonly audience: readonly string[];
  /** The schema of the `data` of each occurrence: an object schema. With no payload schema, the data is an empty object. */
  readonly payload?: StandardSchemaV1<unknown, Payload> | undefined;
}

/** An event with an input schema. `subscribe` receives the output of the schema. */
export interface EventWithInput<Context, Input, Payload> {
  readonly input: StandardSchemaV1<unknown, Input>;
  readonly subscribe: Subscribe<Context, Input, Payload>;
}

/** An event with no input schema. `subscribe` receives an empty object. */
export interface EventWithoutInput<Context, Payload> {
  readonly input?: undefined;
  readonly subscribe: Subscribe<Context, EmptyInput, Payload>;
}

/** An event as an application declares it (spec/events.md). `Input` and `Payload` are the outputs of its schemas. */
export type EventDeclaration<Context, Input, Payload, Id extends string> = EventParts<Payload, Id> &
  (EventWithInput<Context, Input, Payload> | EventWithoutInput<Context, Payload>);

/** The result of `decode` of an event: the issues of an input that is not valid, or the start of the subscription. */
export type DecodedEvent<Context> =
  | { readonly issues: readonly StandardSchemaV1.Issue[] }
  | { readonly start: (subscription: Subscription<Context>) => AsyncIterable<Emitted<unknown>> };

/** An event that `defineEvent` or `eventsFor` made: its declaration, and `decode`. */
export type EventDefinition<Context = unknown, Input = EmptyInput, Payload = EmptyInput, Id extends string = string> = EventDeclaration<Context, Input, Payload, Id> & {
  readonly decode: (input: unknown) => Promise<DecodedEvent<Context>>;
};

/** Any event whose services the context `Context` gives, whatever its schemas are. */
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
export function defineEvent<Context = unknown, Input = EmptyInput, Payload = EmptyInput, const Id extends string = string>(
  declaration: EventParts<Payload, Id> & EventWithInput<Context, Input, Payload>,
): EventDefinition<Context, Input, Payload, Id>;
export function defineEvent<Context = unknown, Payload = EmptyInput, const Id extends string = string>(
  declaration: EventParts<Payload, Id> & EventWithoutInput<Context, Payload>,
): EventDefinition<Context, EmptyInput, Payload, Id>;
// The two signatures exist so that `subscribe` gets the type of its input from `input`, as for `defineCapability`.
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

/** The function that `eventsFor` gives: `defineEvent`, with one context type. */
export interface EventFactory<Context> {
  <Input, Payload = EmptyInput, const Id extends string = string>(
    declaration: EventParts<Payload, Id> & EventWithInput<Context, Input, Payload>,
  ): EventDefinition<Context, Input, Payload, Id>;
  <Payload = EmptyInput, const Id extends string = string>(declaration: EventParts<Payload, Id> & EventWithoutInput<Context, Payload>): EventDefinition<Context, EmptyInput, Payload, Id>;
}

/** Declare events for one context type, as `capabilitiesFor` does for capabilities. */
export const eventsFor = <Context>(): EventFactory<Context> => defineEvent;

export interface Target {
  readonly bindings: readonly string[];
  readonly description?: string | undefined;
  readonly options?: JsonObject | undefined;
}

export interface App<Context = unknown> {
  readonly title?: string | undefined;
  readonly description?: string | undefined;
  readonly targets: { readonly [name: string]: Target };
  readonly capabilities: readonly AnyCapability<Context>[];
  /** The events (spec/events.md). Capabilities and events share one set of ids. */
  readonly events?: readonly AnyEventDefinition<Context>[] | undefined;
}

/** Declare an application. */
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
          ...(target.options === undefined ? {} : { options: target.options }),
        },
      ]),
    ),
    ...(Object.keys(types).length === 0 ? {} : { $defs: types }),
    capabilities,
    ...(Object.keys(events).length === 0 ? {} : { events }),
  };
}

/** The catalog of an application, as text in canonical form. */
export const renderCatalog = (app: App<never>, options: { readonly toJsonSchema: ToJsonSchema }): string =>
  canonicalText(catalogOf(app, options));
