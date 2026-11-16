import type { Check } from "@acid-cat/cli";

export const deadline = 10_000;

export const timeout = 120_000;

export const didNotSettle = new RegExp(`^did not settle within ${deadline} ms`);

export const failures = (results: readonly Check[]) =>
  results
    .filter((result) => !result.passed)
    .map((result) => `${result.binding}: ${result.name}: ${result.detail}`)
    .join("\n");
