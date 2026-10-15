/** The result of one conformance check, and helpers to write checks. */
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

/** Collects checks for one binding. */
export class Checks {
  readonly results: Check[] = [];
  readonly binding: string;

  constructor(binding: string) {
    this.binding = binding;
  }

  async run(name: string, rule: string, body: () => Promise<void> | void): Promise<void> {
    try {
      await body();
      this.results.push({ binding: this.binding, name, rule, passed: true });
    } catch (error) {
      this.results.push({ binding: this.binding, name, rule, passed: false, detail: error instanceof Error ? error.message : String(error) });
    }
  }
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

/**
 * The longest time, in milliseconds, that a check waits for one thing of the implementation by default: an outcome, a
 * state, a process. It is a limit of the infrastructure, so that an implementation that never answers fails its check
 * and the run ends. It is never a condition for a check to pass.
 */
export const GUARD = 30_000;

/** Wait for a promise, for `guard` milliseconds at most. After that, fail with "did not settle". */
export function within<T>(promise: Promise<T>, guard: number, what: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const limit = new Promise<never>((_, reject) => {
    timer = setTimeout(() => reject(new Error(`${what} did not settle within ${guard} ms, the guard of acid-cat conform`)), guard);
  });
  return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
}

/**
 * Read a state until `condition` is true. After `guard` milliseconds, fail with "did not settle". The reads are the
 * trigger; the guard only ends a wait that would not end.
 */
export async function until<T>(read: () => Promise<T>, condition: (value: T) => boolean, guard: number, what: string): Promise<void> {
  const end = performance.now() + guard;
  for (;;) {
    if (condition(await within(read(), guard, what))) return;
    if (performance.now() > end) throw new Error(`${what} did not settle within ${guard} ms, the guard of acid-cat conform`);
    await new Promise((resolve) => setTimeout(resolve, 5));
  }
}
