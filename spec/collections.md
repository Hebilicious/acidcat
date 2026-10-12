# Collections

Every value that crosses a boundary has a bounded size. A collection that can keep growing is returned one page at a time, and a caller always knows when there is more.

Closes divergence row D10.

## Bounds

An output that holds only part of a collection MUST say so, and MUST tell the caller how to get the rest. Truncation is never silent.

Arrays SHOULD state `maxItems`, and objects that admit keys they do not name SHOULD state `maxProperties`. A bound that a schema states holds at runtime too, because values must [agree with the manifest](manifest.md#agreement-with-behaviour).

## Pages

A collection that grows with use, or that covers space, is usually best returned in pages. A paged capability SHOULD take this shape:

- Input: `limit`, an integer from 1 up to a maximum the capability states; and `cursor`, an optional opaque string taken from a previous page.
- Output: `items`, whose `maxItems` is that maximum; and `nextCursor`, a string, or `null` when there is nothing more.

When the collection has changed in a way that the cursor cannot follow, the capability reports an expected failure. It does not silently skip or repeat items.

## Rationale

*This section is not normative.*

**One firm rule.** JB's specification requires bounded aggregates to be returned whole, and growing collections to use limits and continuation with no silent truncation. Only the last part is a requirement here: a caller must never mistake part of a collection for all of it. Bounds on every array are good practice, and JB's conformance suite enforces them for JB. Requiring them everywhere would force every small application to bound its lists before it has any reason to. HS's history keeps the 20 newest entries, newest first. That is a domain rule, and it should say so in its description, because otherwise it reads as truncation.

**Why the page shape is a SHOULD.** JB pages in at least three ways: `offset`/`nextOffset` with a revision for history and resources, `continuation` for the atlas and map items, and a `revision` that fails when it is stale. A single shape lets a generic adapter, such as a CLI `--all` flag or an agent's page loop, follow any capability. The cursor names match MCP's own pagination. An opaque cursor can carry JB's offset and revision together. The shape is a SHOULD so that JB's existing contracts still conform, and so that a capability with good reason to page differently can do so.

**Changes for each implementation.**
- JB: `navigation.atlas.feature.inspect` declares at most 100 `connections` but returns them unsliced. Outputs are encoded with checks disabled, so nothing catches this.
- HS: state in `primes.history.list`'s description that the history holds the 20 newest entries.
