import type { Availability } from "@acid-cat/spec-ts";

/** True if two availability values are the same. */
export const sameAvailability = (left: Availability, right: Availability): boolean =>
  left.available === right.available && (left.available || left.reason === (right as { readonly reason: string }).reason);
