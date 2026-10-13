# Pagination

An output that contains only part of a collection MUST say so. It MUST tell the client how to get the remaining part. This rule applies to all capabilities, also to capabilities that do not use the convention below.

## Convention

Return a collection that can become large in pages:

- **Input:** `limit` is an integer from 1 to a maximum that the capability sets. `cursor` is an optional string from a previous page.
- **Output:** `items` is an array. Its `maxItems` is the maximum. `nextCursor` is a string, or `null` if there are no more items.

If the collection changes and the cursor cannot continue, the capability returns a failure. It MUST NOT skip or repeat items.

Other arrays SHOULD have `maxItems`. If a collection has a fixed limit, for example the 20 most recent items, its description SHOULD say so.
