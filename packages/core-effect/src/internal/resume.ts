/**
 * The check of the options of a subscription (spec/events.md#resuming).
 */
import type { Resume } from "@acid-cat/spec-ts";

/**
 * The message of the call failure `invalid-input` when the options of a subscription are not valid, or `undefined` when
 * they are valid. `maxAgeMs` must be an integer that is 0 or more.
 */
export const resumeIssue = (resume: Resume): string | undefined =>
  resume.maxAgeMs === undefined || (Number.isInteger(resume.maxAgeMs) && resume.maxAgeMs >= 0)
    ? undefined
    : "maxAgeMs: Expected an integer that is 0 or more.";

/**
 * The `maxAgeMs` of the JSON params of a binding. An absent value and `null` give no `maxAgeMs`. A value that is not a
 * number becomes `NaN`, which `resumeIssue` rejects. The binding gives it to the session, which checks it after it
 * looks up the id, in the order of the call failures.
 */
export const maxAgeOf = (value: unknown): number | undefined =>
  value === undefined || value === null ? undefined : typeof value === "number" ? value : Number.NaN;
