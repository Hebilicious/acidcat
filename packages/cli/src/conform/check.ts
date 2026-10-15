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

/**
 * Collects checks for one binding. Each check has one deadline, `guard` milliseconds after it starts. At the deadline,
 * the check fails with "did not settle", and its signal aborts, so that the operations of the check that still run on
 * the side of the client stop.
 */
export class Checks {
  readonly results: Check[] = [];
  readonly binding: string;
  readonly guard: number;

  constructor(binding: string, guard: number = GUARD) {
    this.binding = binding;
    this.guard = guard;
  }

  async run(name: string, rule: string, body: (deadline: Deadline) => Promise<void> | void): Promise<void> {
    const deadline = new Deadline(this.guard);
    try {
      await deadline.within(Promise.resolve().then(() => body(deadline)), `the check "${name}"`);
      this.results.push({ binding: this.binding, name, rule, passed: true });
    } catch (error) {
      deadline.cancel(new Error(`the check "${name}" failed`));
      this.results.push({ binding: this.binding, name, rule, passed: false, detail: error instanceof Error ? error.message : String(error) });
    } finally {
      deadline.end();
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
 * The longest time, in milliseconds, that one check waits for the implementation by default. It is a limit of the
 * infrastructure, so that an implementation that never answers fails its check and the run ends. It is never a
 * condition for a check to pass.
 */
export const GUARD = 30_000;

/** The message of a wait that reached the guard. */
const unsettled = (what: string, guard: number) => `${what} did not settle within ${guard} ms, the guard of acid-cat conform`;

/**
 * One deadline for a check, or for a step of the checks: `guard` milliseconds after it starts. Each wait in it gets the
 * time that is left, so that no wait starts the guard again. At the deadline, `signal` aborts.
 */
export class Deadline {
  readonly guard: number;
  readonly #end: number;
  readonly #controller = new AbortController();
  #timer: ReturnType<typeof setTimeout> | undefined;

  constructor(guard: number) {
    this.guard = guard;
    this.#end = performance.now() + guard;
    this.#timer = setTimeout(() => this.#controller.abort(new Error(unsettled("the step", guard))), guard);
  }

  /** Aborts at the deadline. Give it to each operation of the client, so that the operation stops. */
  get signal(): AbortSignal {
    return this.#controller.signal;
  }

  /** The milliseconds that are left. */
  get left(): number {
    return Math.max(0, this.#end - performance.now());
  }

  /** Wait for a promise until the deadline. After that, fail with "did not settle". */
  within<T>(promise: Promise<T>, what: string): Promise<T> {
    const expire = (reject: (error: Error) => void) => {
      const error = new Error(unsettled(what, this.guard));
      this.#controller.abort(error);
      reject(error);
    };
    if (this.left === 0) {
      promise.catch(() => undefined);
      return new Promise<never>((_, reject) => expire(reject));
    }
    let timer: ReturnType<typeof setTimeout> | undefined;
    const limit = new Promise<never>((_, reject) => {
      timer = setTimeout(() => expire(reject), this.left);
    });
    return Promise.race([promise, limit]).finally(() => clearTimeout(timer));
  }

  /** Read a state until `condition` is true, until the deadline. The reads are the trigger, not the time. */
  async until<T>(read: (signal: AbortSignal) => Promise<T>, condition: (value: T) => boolean, what: string): Promise<void> {
    for (;;) {
      if (condition(await this.within(read(this.signal), what))) return;
      if (this.left === 0) throw new Error(unsettled(what, this.guard));
      await new Promise((resolve) => setTimeout(resolve, 5));
    }
  }

  /** Stop the operations of the step that still run, for example after it failed. */
  cancel(reason: Error): void {
    this.#controller.abort(reason);
  }

  /** Stop the timer of the deadline, when the step ends before it. */
  end(): void {
    clearTimeout(this.#timer);
  }
}

/** Wait for a promise, for `guard` milliseconds at most. After that, fail with "did not settle". */
export function within<T>(promise: Promise<T>, guard: number, what: string): Promise<T> {
  const deadline = new Deadline(guard);
  return deadline.within(promise, what).finally(() => deadline.end());
}

/** A `fetch` that stops at the deadline of a check, and also at `signal`. */
export const fetchUntil = (deadline: Deadline, input: string, init: RequestInit = {}): Promise<Response> =>
  fetch(input, { ...init, signal: init.signal ? AbortSignal.any([init.signal, deadline.signal]) : deadline.signal });
