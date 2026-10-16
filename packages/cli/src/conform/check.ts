/** The result of one conformance check, and helpers to write checks. */
import { setTimeout as pause } from "node:timers/promises";

import fixtureJson from "../../conformance/fixture.acidcat.json" with { type: "json" };
import { viewOf } from "@acid-cat/spec-ts";
import type { CatalogDocument } from "@acid-cat/spec-ts";

export interface Check {
  readonly binding: string;
  readonly name: string;
  /** The part of the specification that the check tests, for example `spec/bindings/mcp.md#tools`. */
  readonly rule: string;
  readonly passed: boolean;
  readonly detail?: string | undefined;
}

/** The conformance fixture: the catalog that each implementation serves. */
export const fixture = fixtureJson as unknown as CatalogDocument;

/** The ids of the capabilities in the view of a target of the fixture. */
export const idsOf = (target: string): string[] => Object.keys(viewOf(fixture, target).capabilities).sort();

/** The time, in milliseconds, that each check has to settle when `conform` gets no other time. */
export const DEADLINE = 30_000;

/**
 * Collects checks for one binding. Each check has one deadline. The check gives its signal to each operation, and the
 * signal aborts at the deadline. Then each operation stops, and the check fails with "did not settle". The deadline
 * never makes a check pass.
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
