# Identifiers and namespaces

Every capability has an **id**, which is its name on every surface. The first segment of the id is the capability's **namespace**.

Closes divergence row D4.

## Id

An id is two or more segments joined by `.`. Each segment matches `[a-z][a-z0-9]*(-[a-z0-9]+)*`, and the whole id is at most 128 characters long. Examples: `primes.check`, `bartering.plan.generate`, `economy.crow-coin.trade-catalog.inspect`.

Ids MUST be unique within a catalog.

Bindings MUST derive every surface name (tool name, command path, method name) from the id, never from where the leaf sits in the catalog tree.

## Namespace

A catalog groups its capabilities by namespace at its top level: the leaves beneath the top-level key `k` are exactly the capabilities whose ids begin with `k.`. How the tree is nested below that key is up to the implementation.

The namespace `acidcat` is reserved for capabilities that this specification defines.

## Rationale

*This section is not normative.*

**HS's rule is adopted, and its tree rule is not.** Both catalogs already group leaves by their first segment, and every id in both fits the grammar above. JB's tree below the namespace uses camelCase keys (`economy.crowCoin`) and groups leaves differently from their ids, so requiring the tree to mirror the ids would force a refactor that changes nothing on the wire. That is why surface names come from the id.

**128 characters.** MCP limits tool names to 128 characters drawn from `[A-Za-z0-9_.-]`, and binding ids to tool names one-to-one is simplest when every id is already a valid tool name. Both implementations check for 160 characters today, and the longest id in either catalog has 39.

**Enforcement.** The inventory said HS's lint enforces the namespace prefix. Its lint actually enforces the bypass rule (only the root imports domain packages), and the prefix is held by convention. The conformance kit can check the grammar and uniqueness from a manifest. The grouping is in-process, so the reference implementation's catalog walk enforces it.

**Reserved namespace.** Discovery and introspection may one day be served as capabilities. Reserving `acidcat` keeps them from colliding with an application's own namespaces.
