import { callFailure } from "@acid-cat/spec-ts";
import type { CallFailure, Resume } from "@acid-cat/spec-ts";

const MAX_AGE_ISSUE = "maxAgeMs: Expected an integer that is 0 or more.";

const isMaxAgeMs = (value: number): boolean => Number.isSafeInteger(value) && value >= 0;

export const resumeIssue = (resume: Resume): string | undefined =>
  resume.maxAgeMs === undefined || isMaxAgeMs(resume.maxAgeMs) ? undefined : MAX_AGE_ISSUE;

export type MaxAge =
  | { readonly _tag: "Absent" }
  | { readonly _tag: "Valid"; readonly maxAgeMs: number }
  | { readonly _tag: "Invalid"; readonly issue: string };

export const maxAgeOf = (value: unknown): MaxAge =>
  value === undefined || value === null
    ? { _tag: "Absent" }
    : typeof value === "number" && isMaxAgeMs(value)
      ? { _tag: "Valid", maxAgeMs: value }
      : { _tag: "Invalid", issue: MAX_AGE_ISSUE };

/** The session rejects this value as `invalid-input`, after its checks for a closed session and an unknown event. */
const REJECTED_MAX_AGE_MS = Number.NaN;

export const resumeOf = (cursor: unknown, maxAge: MaxAge): Resume => ({
  ...(typeof cursor === "string" ? { cursor } : {}),
  ...(maxAge._tag === "Valid" ? { maxAgeMs: maxAge.maxAgeMs } : {}),
  ...(maxAge._tag === "Invalid" ? { maxAgeMs: REJECTED_MAX_AGE_MS } : {}),
});

/**
 * The call failure of an invalid `maxAgeMs`. An unknown event comes before an invalid `maxAgeMs`
 * (spec/events.md#subscribing).
 */
export const maxAgeFailure = (events: object | undefined, name: string, issue: string): CallFailure =>
  Object.hasOwn(events ?? {}, name) ? callFailure("invalid-input", issue) : callFailure("unknown-capability", `There is no event ${name}.`);
