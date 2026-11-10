/** The result of one conformance check, and helpers to write checks. */
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
  readonly detail?: string | undefined;
}

/** The conformance fixture: the catalog that each implementation serves. */
export const fixture: CatalogDocument = fixtureJson;

/**
 * True if the value is an outcome (spec/invocation.md): `{ ok: true, value }`, `{ ok: false, error }`, or a call
 * failure `{ kind, message }` with no `ok`.
 */
export const isOutcome = (value: unknown): value is Outcome<unknown, unknown> => {
  if (!isObject(value)) return false;
  if (value.ok === true) return "value" in value;
  if (value.ok === false) return "error" in value;
  return !("ok" in value) && CALL_FAILURE_KINDS.some((kind) => kind === value.kind) && typeof value.message === "string";
};

/** The ids of the capabilities in the view of a target of the fixture. */
export const idsOf = (target: string): string[] => Object.keys(viewOf(fixture, target).capabilities).sort();

/** The ids of the events in the view of a target of the fixture. */
export const eventIdsOf = (target: string): string[] => Object.keys(viewOf(fixture, target).events ?? {}).sort();

/** A check of a payload against the payload schema of an event of the fixture, made once for each event. */
const payloadChecks = new Map<string, (data: unknown) => boolean>();

/** True if the data agrees with the payload schema of the event. With no payload schema, the data is an empty object. */
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

/**
 * The value as an occurrence of the event `id`: an occurrence in its JSON form (schemas/occurrence.schema.json), with
 * the id as its name, and data that agrees with the payload schema. The check fails when the value is not one.
 */
export function expectOccurrence(value: unknown, id: string): Occurrence {
  expect(isOccurrence(value), `expected an occurrence, got ${JSON.stringify(value)}`);
  expectEqual(value.name, id, "the name of the occurrence");
  expect(agreesWithPayload(id, value.data), `the data of the occurrence must agree with the payload schema of ${id}, got ${JSON.stringify(value.data)}`);
  return value;
}

/** The time, in milliseconds, that each check has to settle when `conform` gets no other time. */
export const DEADLINE = 30_000;

/**
 * Collects checks for one binding. Each check has one deadline. The check gives its signal to each operation, and the
 * signal aborts at the deadline. Then each operation stops, and the check fails with "did not settle". The deadline
 * never makes a check pass. The cleanup of a check, which releases what the check holds, gets its own signal with the
 * same time, so that `conform` always returns.
 */
export class Checks {
  readonly results: Check[] = [];
  readonly binding: string;
  readonly deadline: number;

  constructor(binding: string, deadline: number) {
    this.binding = binding;
    this.deadline = deadline;
  }

  async run(name: string, rule: string, body: (signal: AbortSignal) => Promise<void> | void): Promise<void> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), this.deadline);
    try {
      await body(controller.signal);
      this.results.push({ binding: this.binding, name, rule, passed: true });
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const detail = controller.signal.aborted ? `did not settle within ${this.deadline} ms: ${message}` : message;
      this.results.push({ binding: this.binding, name, rule, passed: false, detail });
    } finally {
      clearTimeout(timer);
    }
  }
}

/**
 * Read a state until `done` is true for it, and give that value. The read and the pause between two reads stop when the
 * signal of the check aborts.
 */
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

/** Settle as the promise does, or reject with the reason of the signal when it aborts first. */
export function abortable<T>(promise: Promise<T>, signal: AbortSignal): Promise<T> {
  const aborted = new Promise<never>((_, reject) => {
    signal.throwIfAborted();
    signal.addEventListener("abort", () => reject(signal.reason), { once: true });
  });
  return Promise.race([promise, aborted]);
}

/** Fail a check unless `condition` is true. */
export function expect(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}

/** Fail a check unless the two values have the same JSON. */
export function expectEqual(actual: unknown, expected: unknown, what: string): void {
  const a = JSON.stringify(actual);
  const b = JSON.stringify(expected);
  if (a !== b) throw new Error(`${what}: expected ${b}, got ${a}`);
}

/** A sorted copy of a list. */
export const sorted = (values: Iterable<string>): string[] => [...values].sort();

/** An origin that no deployment allows. */
export const FORBIDDEN_ORIGIN = "https://not-allowed.acid-cat.invalid";
