import { availableParallelism } from "node:os";
import { setTimeout as pause } from "node:timers/promises";

import fixtureJson from "../../conformance/fixture.acidcat.json" with { type: "json" };
import { CALL_FAILURE_KINDS, isOccurrence, viewOf } from "@acid-cat/spec-ts";
import type { CatalogDocument, Occurrence, Outcome } from "@acid-cat/spec-ts";
import { Schema, SchemaRepresentation } from "effect";
import type { JsonSchema } from "effect";

import { isObject } from "../json.ts";

export interface Check {
  readonly binding: string;
  readonly name: string;
  /** The part of the specification that the check tests, for example `spec/bindings/mcp.md#tools`. */
  readonly rule: string;
  readonly passed: boolean;
  /** `true` when the check tests a recommendation (SHOULD) that the implementation does not follow. The check still passes. */
  readonly warning?: boolean | undefined;
  readonly detail?: string | undefined;
}

/** The conformance fixture: the catalog that each implementation serves. */
export const fixture: CatalogDocument = fixtureJson;

export const isOutcome = (value: unknown): value is Outcome<unknown, unknown> => {
  if (!isObject(value)) return false;
  if (value.ok === true) return "value" in value;
  if (value.ok === false) return "error" in value;
  return !("ok" in value) && CALL_FAILURE_KINDS.some((kind) => kind === value.kind) && typeof value.message === "string";
};

export const idsOf = (target: string): string[] => Object.keys(viewOf(fixture, target).capabilities).sort();

export const eventIdsOf = (target: string): string[] => Object.keys(viewOf(fixture, target).events ?? {}).sort();

const payloadChecks = new Map<string, (data: unknown) => boolean>();

function agreesWithPayload(id: string, data: unknown): boolean {
  let agrees = payloadChecks.get(id);
  if (agrees === undefined) {
    const payload = fixture.events?.[id]?.payload;
    if (payload === undefined) {
      agrees = (value) => isObject(value) && Object.keys(value).length === 0;
    } else {
      const definitions: JsonSchema.Definitions = fixture.$defs ?? {};
      const schema = SchemaRepresentation.fromJsonSchemaDocument({ dialect: "draft-2020-12", schema: payload, definitions }, { patterns: "apply" });
      agrees = Schema.is(Schema.toType(schema));
    }
    payloadChecks.set(id, agrees);
  }
  return agrees(data);
}

export function expectOccurrence(value: unknown, id: string): Occurrence {
  expect(isOccurrence(value), `expected an occurrence, got ${JSON.stringify(value)}`);
  expectEqual(value.name, id, "the name of the occurrence");
  expect(agreesWithPayload(id, value.data), `the data of the occurrence must agree with the payload schema of ${id}, got ${JSON.stringify(value.data)}`);
  return value;
}

export const DEADLINE = 30_000;

type Body = (signal: AbortSignal) => Promise<void> | void;

export type Define = (name: string, rule: string, body: Body) => void;

export class Checks {
  readonly results: Check[] = [];
  readonly binding: string;
  readonly deadline: number;

  constructor(binding: string, deadline: number) {
    this.binding = binding;
    this.deadline = deadline;
  }

  async run(name: string, rule: string, body: Body): Promise<void> {
    this.results.push(this.#result(name, rule, await this.#settle(body)));
  }

  async concurrently(define: (check: Define) => void): Promise<void> {
    const defined: { readonly name: string; readonly rule: string; readonly body: Body }[] = [];
    define((name, rule, body) => defined.push({ name, rule, body }));
    const queue = defined.entries();
    const settled: (readonly [number, Check])[] = [];
    const worker = async () => {
      for (const [index, { name, rule, body }] of queue) settled.push([index, this.#result(name, rule, await this.#settle(body))]);
    };
    await Promise.all(Array.from({ length: availableParallelism() }, worker));
    this.results.push(...settled.sort(([a], [b]) => a - b).map(([, check]) => check));
  }

  #result(name: string, rule: string, failure: string | undefined): Check {
    return failure === undefined ? { binding: this.binding, name, rule, passed: true } : { binding: this.binding, name, rule, passed: false, detail: failure };
  }

  async should(name: string, rule: string, body: Body): Promise<void> {
    const failure = await this.#settle(body);
    this.results.push(failure === undefined ? { binding: this.binding, name, rule, passed: true } : { binding: this.binding, name, rule, passed: true, warning: true, detail: failure });
  }

  async #settle(body: Body): Promise<string | undefined> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deadline);
    try {
      await body(controller.signal);
      return undefined;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      return controller.signal.aborted ? `did not settle within ${this.deadline} ms: ${message}` : message;
    } finally {
      clearTimeout(timer);
    }
  }
}

export async function until<T, Done extends T>(what: string, read: () => Promise<T>, done: (value: T) => value is Done, signal: AbortSignal): Promise<Done>;
export async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, signal: AbortSignal): Promise<T>;
export async function until<T>(what: string, read: () => Promise<T>, done: (value: T) => boolean, signal: AbortSignal): Promise<T> {
  let last: T | undefined;
  try {
    for (;;) {
      last = await read();
      if (done(last)) return last;
      await pause(10, undefined, { signal });
    }
  } catch (error) {
    throw signal.aborted ? new Error(`waiting until ${what}; the last value was ${JSON.stringify(last)}`) : error;
  }
}

export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = new Promise<never>((_, reject) => {
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([promise, aborted]);
}

export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

export function expectEqual(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

export const sorted = (values: Iterable<string>): string[] => [...values].sort();

export const FORBIDDEN_ORIGIN = "https://not-allowed.acid-cat.invalid";
