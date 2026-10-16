/**
 * Capabilities and applications in plain TypeScript. An application writes its own catalog.
 * See spec/catalog.md.
 */
import { canonicalText } from "@acid-cat/catalog";
import { objectInput } from "@acid-cat/spec-ts";
import type { Availability, CatalogCapability, CatalogDocument, JsonObject, Result } from "@acid-cat/spec-ts";

import type { StandardSchemaV1 } from "./standard-schema.ts";

/** A value that can change, and that a client can follow (spec/bindings/typescript.md#handles). */
export interface Observable<T> {
  getSnapshot(): T;
  subscribe(listener: (value: T) => void): { unsubscribe(): void };
}

/** The input that `run` receives: the output of the input schema, or an empty object. */
export type InputOf<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : Record<string, never>;
/** The value of a successful call: the output of the output schema, or `null`. */
export type Output<S> = S extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<S> : null;
/** The failures, each with its `_tag`. */
export type FailureOf<F> = { [Tag in keyof F]: { readonly _tag: Tag } & (F[Tag] extends StandardSchemaV1 ? StandardSchemaV1.InferOutput<F[Tag]> : object) }[keyof F];

export interface Capability<
  Context = unknown,
  Input extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  OutputSchema extends StandardSchemaV1 | undefined = StandardSchemaV1 | undefined,
  Failures extends { readonly [tag: string]: StandardSchemaV1 } = { readonly [tag: string]: StandardSchemaV1 },
  StateSchema extends StandardSchemaV1 = StandardSchemaV1,
> {
  readonly id: string;
  readonly description: string;
  /** The targets that can use the capability. With no audience, no target can use it. */
  readonly audience: readonly string[];
  readonly readOnly?: boolean | undefined;
  /**
   * The input: an object schema, or a union of object schemas. The catalog writes a union with `"type": "object"`. With
   * no input schema, the input is an empty object.
   */
  readonly input?: Input;
  /** The value of a successful call. With no output schema, the value is `null`. */
  readonly output?: OutputSchema;
  /** The failures, by tag. The schema of a failure describes the object, without or with its `_tag`. */
  readonly failures?: Failures;
  /** A value that clients can observe (spec/invocation.md#state): its schema, and its source. */
  readonly state?:
    | { readonly schema: StateSchema; readonly source: (context: Context) => Observable<StandardSchemaV1.InferOutput<StateSchema>> }
    | undefined;
  /** The availability of the capability. With none, the capability is always available. */
  readonly availability?: ((context: Context) => Observable<Availability>) | undefined;
  readonly run: (
    input: InputOf<Input>,
    call: { readonly signal: AbortSignal; readonly context: Context },
  ) => Promise<Result<Output<OutputSchema>, FailureOf<Failures>>> | Result<Output<OutputSchema>, FailureOf<Failures>>;
}

export type AnyCapability<Context = any> = Capability<Context, any, any, any, any>;

/** Declare a capability. `Context` is the type of the services that `run` receives. */
export const defineCapability = <
  Context = unknown,
  Input extends StandardSchemaV1 | undefined = undefined,
  OutputSchema extends StandardSchemaV1 | undefined = undefined,
  Failures extends { readonly [tag: string]: StandardSchemaV1 } = {},
  StateSchema extends StandardSchemaV1 = never,
>(
  capability: Capability<Context, Input, OutputSchema, Failures, StateSchema>,
): Capability<Context, Input, OutputSchema, Failures, StateSchema> => capability;

/**
 * Declare capabilities for one context type. The other types come from the schemas:
 *
 * ```ts
 * const capability = capabilitiesFor<{ unit: Unit }>();
 * capability({ id: "aircon.power.set", input: z.object({ on: z.boolean() }), run: ({ on }, { context }) => … });
 * ```
 */
export const capabilitiesFor =
  <Context>() =>
  <
    Input extends StandardSchemaV1 | undefined = undefined,
    OutputSchema extends StandardSchemaV1 | undefined = undefined,
    Failures extends { readonly [tag: string]: StandardSchemaV1 } = {},
    StateSchema extends StandardSchemaV1 = never,
  >(
    capability: Capability<Context, Input, OutputSchema, Failures, StateSchema>,
  ): Capability<Context, Input, OutputSchema, Failures, StateSchema> =>
    capability;

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
}

/** Declare an application. */
export const defineApp = <Context = unknown>(app: App<Context>): App<Context> => app;

/** Converts a schema to JSON Schema 2020-12, for example `(schema) => z.toJSONSchema(schema)` with Zod. */
export type ToJsonSchema = (schema: StandardSchemaV1) => JsonObject;

const catalogs = new WeakMap<App<any>, WeakMap<ToJsonSchema, CatalogDocument>>();

/**
 * The catalog of an application, as a JSON document. The catalog is written one time for each application and
 * `toJsonSchema`. Later calls with the same two give the same document.
 */
export function catalogOf(app: App<any>, options: { readonly toJsonSchema: ToJsonSchema }): CatalogDocument {
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

function write(app: App<any>, toJsonSchema: ToJsonSchema): CatalogDocument {
  const types: Record<string, JsonObject> = {};

  const toJson = (schema: StandardSchemaV1, where: string): JsonObject => {
    const { $schema: _, $defs, ...json } = toJsonSchema(schema) as JsonObject & { $defs?: Record<string, JsonObject> };
    for (const [name, definition] of Object.entries($defs ?? {})) {
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
      Object.entries((capability.failures ?? {}) as Record<string, StandardSchemaV1>).map(([tag, schema]) => [tag, toJson(schema, capability.id)]),
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
export const renderCatalog = (app: App<any>, options: { readonly toJsonSchema: ToJsonSchema }): string =>
  canonicalText(catalogOf(app, options));
