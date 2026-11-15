import type { Check } from "@acid-cat/cli";

/**
 * The deadline of the conformance tests of a fixture that must fail some checks: an implementation that ignores
 * cancellation, and a command line that never writes its marker. The checks that must fail end at this deadline. Each
 * other check settles long before it. The deadline is short, because each check that must fail waits for it.
 */
export const deadline = 10_000;

/**
 * The test timeout of these conformance tests. On a computer that runs many tests at the same time, they can take close
 * to the test timeout of the task, which is one minute.
 */
export const timeout = 120_000;

/** The start of the detail of a check that ends at the deadline. */
export const didNotSettle = new RegExp(`^did not settle within ${deadline} ms`);

/** The binding, the name and the detail of each check that failed, one on each line, for the message of an assertion. */
export const failures = (results: readonly Check[]) =>
  results
    .filter((result) => !result.passed)
    .map((result) => `${result.binding}: ${result.name}: ${result.detail}`)
    .join("\n");
