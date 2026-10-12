# Pagination

An output that holds only part of a collection MUST say so and MUST tell the client how to get the rest. This rule applies whether or not a capability follows the convention below. Truncation is never silent.

## Convention

A collection that grows with use, or that covers space, is returned in pages:

- **Input:** `limit`, an integer from 1 up to a maximum the capability states; and `cursor`, an optional opaque string taken from a previous page.
- **Output:** `items`, an array whose `maxItems` is that maximum; and `nextCursor`, a string, or `null` when there is nothing more.

When the collection has changed in a way the cursor cannot follow, the capability returns a declared failure instead of skipping or repeating items.

Arrays elsewhere SHOULD state `maxItems`, so that every answer has a known bound. A collection bounded by its domain, such as the 20 most recent checks, says so in its description.
