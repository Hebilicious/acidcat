/**
 * Write an AcidCat catalog in TypeScript, and render it to the JSON document the toolchain checks.
 *
 * This is an authoring library, not a runtime: a program uses it to produce `acidcat.catalog.json`, and nothing
 * reads the catalog through it at runtime. See spec/catalog.md.
 */

import { canonicalText } from "./canonical.ts";

export { canonicalText } from "./canonical.ts";

/** A JSON Schema 2020-12 schema, written as a plain object. */
export type Schema = { readonly [keyword: string]: unknown };

export interface TargetOptions {
  /** The bindings that serve the target, such as `"typescript"` and `"webmcp"`. */
  readonly bindings: readonly string[];
  readonly description?: string;
  /** Settings for the bindings, in a form each binding defines. */
  readonly options?: Schema;
}

export interface CapabilityOptions {
  /** What the capability does for its caller, written for people and agents. */
  readonly description: string;
  /** The targets the capability is offered to. Empty means no target. */
  readonly audience?: readonly string[];
  /** The input schema. It must describe an object. Absent means an empty object. */
  readonly input?: Schema;
  /** The schema of a successful call's value. Absent means `null`. */
  readonly output?: Schema;
  /** The failures, keyed by tag. */
  readonly failures?: Readonly<Record<string, Schema>>;
  /** `true` when a call changes nothing anyone can observe. A hint for clients. */
  readonly readOnly?: boolean;
  /** The schema of a value that clients can observe. */
  readonly state?: Schema;
}

const ID = /^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$/;
const NAME = /^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$/;
const TYPE_NAME = /^[A-Za-z][A-Za-z0-9_]*$/;
const REFERENCE = /^#\/\$defs\/([A-Za-z][A-Za-z0-9_]*)$/;

export class Catalog {
  readonly #title: string | undefined;
  readonly #description: string | undefined;
  readonly #targets = new Map<string, TargetOptions>();
  readonly #types = new Map<string, Schema>();
  readonly #capabilities = new Map<string, CapabilityOptions>();

  constructor(options: { readonly title?: string; readonly description?: string } = {}) {
    this.#title = options.title;
    this.#description = options.description;
  }

  /** Declare a target. */
  target(name: string, options: TargetOptions): this {
    if (this.#targets.has(name)) throw new Error(`The target ${name} is declared twice`);
    this.#targets.set(name, options);
    return this;
  }

  /** Declare a shared type, and get the schema that references it. */
  type(name: string, schema: Schema): Schema {
    if (this.#types.has(name)) throw new Error(`The type ${name} is declared twice`);
    this.#types.set(name, schema);
    return { $ref: `#/$defs/${name}` };
  }

  /** Declare a capability. */
  capability(id: string, options: CapabilityOptions): this {
    if (this.#capabilities.has(id)) throw new Error(`The capability ${id} is declared twice`);
    this.#capabilities.set(id, options);
    return this;
  }

  /** The catalog rules this catalog breaks. Empty when it conforms. */
  validate(): string[] {
    const problems: string[] = [];
    for (const [name, target] of this.#targets) {
      if (!NAME.test(name)) problems.push(`the target name ${name} is malformed`);
      if (target.bindings.length === 0) problems.push(`the target ${name} has no bindings`);
      if (new Set(target.bindings).size !== target.bindings.length) problems.push(`the target ${name} repeats a binding`);
      for (const binding of target.bindings) {
        if (!NAME.test(binding)) problems.push(`the target ${name} names the malformed binding ${binding}`);
      }
    }
    for (const [name, schema] of this.#types) {
      if (!TYPE_NAME.test(name)) problems.push(`the type name ${name} is malformed`);
      problems.push(...this.#referenceProblems(schema).map((problem) => `the type ${name} ${problem}`));
    }
    for (const [id, capability] of this.#capabilities) {
      if (id.length > 128 || !ID.test(id)) problems.push(`the id ${id} is malformed`);
      if (capability.description.trim() === "") problems.push(`${id} has no description`);
      const audience = capability.audience ?? [];
      if (new Set(audience).size !== audience.length) problems.push(`${id} repeats a target in its audience`);
      for (const target of audience) {
        if (!this.#targets.has(target)) problems.push(`${id} names the undeclared target ${target}`);
      }
      if (capability.input !== undefined && this.#resolve(capability.input).type !== "object") {
        problems.push(`${id} input does not describe an object`);
      }
      const schemas = [capability.input, capability.output, capability.state, ...Object.values(capability.failures ?? {})];
      for (const schema of schemas) {
        if (schema !== undefined) problems.push(...this.#referenceProblems(schema).map((problem) => `${id} ${problem}`));
      }
    }
    return problems;
  }

  /** The catalog as a JSON value. Throws when the catalog breaks a rule. */
  toJSON(): Schema {
    const problems = this.validate();
    if (problems.length > 0) throw new Error(`The catalog does not conform:\n${problems.join("\n")}`);
    return compact({
      acidcat: "0.1",
      title: this.#title,
      description: this.#description,
      targets: Object.fromEntries(
        [...this.#targets].map(([name, target]) => [
          name,
          compact({ bindings: target.bindings, description: target.description, options: target.options }),
        ]),
      ),
      $defs: this.#types.size === 0 ? undefined : Object.fromEntries(this.#types),
      capabilities: Object.fromEntries(
        [...this.#capabilities].map(([id, capability]) => [
          id,
          compact({
            description: capability.description,
            audience: capability.audience ?? [],
            input: capability.input,
            output: capability.output,
            failures: Object.keys(capability.failures ?? {}).length === 0 ? undefined : capability.failures,
            readOnly: capability.readOnly,
            state: capability.state,
          }),
        ]),
      ),
    });
  }

  /** The catalog as JSON text in canonical form, ready to write to `acidcat.catalog.json`. */
  render(): string {
    return canonicalText(this.toJSON());
  }

  #resolve(schema: Schema): Schema {
    const name = typeof schema.$ref === "string" ? REFERENCE.exec(schema.$ref)?.[1] : undefined;
    return name === undefined ? schema : (this.#types.get(name) ?? schema);
  }

  #referenceProblems(schema: unknown): string[] {
    const problems: string[] = [];
    visit(schema, (node) => {
      if ("$defs" in node) problems.push("carries its own $defs; declare shared types with type()");
      if (node.$ref === undefined) return;
      const name = typeof node.$ref === "string" ? REFERENCE.exec(node.$ref)?.[1] : undefined;
      if (name === undefined || !this.#types.has(name)) problems.push(`references ${String(node.$ref)}, which is not a type`);
    });
    return problems;
  }
}

function compact(value: Record<string, unknown>): Schema {
  return Object.fromEntries(Object.entries(value).filter(([, member]) => member !== undefined));
}

function visit(value: unknown, onObject: (node: Record<string, unknown>) => void): void {
  if (Array.isArray(value)) {
    value.forEach((item) => visit(item, onObject));
  } else if (value !== null && typeof value === "object") {
    onObject(value as Record<string, unknown>);
    Object.values(value).forEach((item) => visit(item, onObject));
  }
}
