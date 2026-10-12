# Collections

Every value that crosses a boundary has a bounded size. A collection that can keep growing is returned one page at a time, and a caller always knows when there is more.

Closes divergence row D10.

## Bounds

In every input, output and error schema:

- every array MUST state `maxItems`;
- every object that admits keys it does not name SHOULD state `maxProperties`.

Because values must [agree with the manifest](manifest.md#agreement-with-behaviour), these bounds hold at runtime as well as in the schema.

A collection whose size is bounded by the domain, such as the six Permutations, is returned whole.

## Pages

A collection that grows with use, or that covers space, is returned in pages. Returning part of a collection without saying so is never allowed: an output that holds part of a collection MUST tell the caller how to get the rest.

A paged capability SHOULD take this shape:

- Input: `limit`, an integer from 1 up to a maximum the capability states; and `cursor`, an optional opaque string taken from a previous page.
- Output: `items`, whose `maxItems` is that maximum; and `nextCursor`, a string, or `null` when there is nothing more.

When the collection has changed in a way that the cursor cannot follow, the capability reports an expected failure. It does not silently skip or repeat items.

## Rationale

*This section is not normative.*

**JB's rule is adopted.** JB's specification requires bounded aggregates to be returned whole, and growing collections to use limits and continuation with no silent truncation. JB's conformance suite checks `maxItems` on every array. HS's history is capped at 20, newest first. That fits a domain bound of 20, but the cap is not declared as such.

**Why the page shape is a SHOULD.** JB pages in at least three ways: `offset`/`nextOffset` with a revision for history and resources, `continuation` for the atlas and map items, and a `revision` that fails when it is stale. A single shape lets a generic adapter, such as a CLI `--all` flag or an agent's page loop, follow any capability. The cursor names match MCP's own pagination. An opaque cursor can carry JB's offset and revision together. The shape is a SHOULD so that JB's existing contracts still conform. Making it a MUST is a later decision for the user.

**Records.** JB's market prices are bounded with `maxProperties`, but its conformance walk does not check records. The rule is a SHOULD until the conformance kit shows how many records are unbounded today.

**Changes for each implementation.**
- JB: `navigation.atlas.feature.inspect` declares at most 100 `connections` but returns them unsliced. Outputs are encoded with checks disabled, so nothing catches this.
- HS: nothing is required, but stating the 20-entry bound as a domain bound in `primes.history.list`'s description would make it explicit.
