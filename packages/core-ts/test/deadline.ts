/**
 * The deadline of the conformance tests whose implementation ignores cancellation. The checks that must fail end at this
 * deadline. Each other check settles long before it. The deadline is short, because each check that must fail waits
 * for it.
 */
export const deadline = 10_000;

/**
 * The test timeout of the conformance tests whose implementation ignores cancellation. On a computer that runs many tests
 * at the same time, they can take close to the test timeout of the task, which is one minute.
 */
export const timeout = 120_000;

/** The start of the detail of a check that ends at the deadline. */
export const didNotSettle = new RegExp(`^did not settle within ${deadline} ms`);
