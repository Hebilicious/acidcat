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
