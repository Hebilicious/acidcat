import type { Resume } from "@acid-cat/spec-ts";

export const resumeIssue = (resume: Resume): string | undefined =>
  resume.maxAgeMs === undefined || (Number.isInteger(resume.maxAgeMs) && resume.maxAgeMs >= 0)
    ? undefined
    : "maxAgeMs: Expected an integer that is 0 or more.";

export const maxAgeOf = (value: unknown): number | undefined =>
  value === undefined || value === null ? undefined : typeof value === "number" ? value : Number.NaN;
