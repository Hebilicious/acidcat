import type { Check } from "@acid-cat/cli";

export const deadline = 10_000;

/** The `--test-timeout` of the `test` task in moon.yml. */
const TASK_TEST_TIMEOUT_MS = 60_000;

/** The test timeout of the conformance tests. A busy computer can take more than the timeout of the task. */
export const timeout = 2 * TASK_TEST_TIMEOUT_MS;

export const didNotSettle = new RegExp(`^did not settle within ${deadline} ms`);

export const failures = (results: readonly Check[]) =>
  results
    .filter((result) => !result.passed)
    .map((result) => `${result.surface}: ${result.name}: ${result.detail}`)
    .join("\n");
