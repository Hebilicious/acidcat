# GraphQL binding

A protocol binding that serves a view as a GraphQL schema generated from the catalog. It depends on [Catalog](../catalog.md), [Invocation](../invocation.md) and the rules for [remote bindings](README.md#remote-bindings).

## Schema

- **Names.** Each capability is a root field, named by joining its id's segments in camelCase: `aircon.power.set` becomes `airconPowerSet`. A `readOnly` capability is a field of `Query`, and any other capability is a field of `Mutation`.
- **Input.** The field takes one argument, `input`. Its type is generated from the input schema, or it is the `JSON` scalar when the schema has no faithful GraphQL type.
- **Outcomes.** The field returns a union of a value type and one type for each failure tag, with `__typename` telling them apart. A call failure is a GraphQL error whose `extensions.kind` is the kind, and the field is `null`.
- **Listing.** `Query.acidcatCatalog: JSON!` returns the view. `Query.acidcatCapabilities` returns the `id`, `available` and `reason` of each capability.
- **Generic access.** `Mutation.acidcatInvoke(id: String!, input: JSON): JSON!` returns the outcome in its JSON form, so that every capability can also be reached by id.
- **Cancellation.** Abandoning the request cancels its calls.

Each type in `$defs` becomes a GraphQL type with the same name. Other generated types take their name from the schema's `title` when it has one, and otherwise from the field name with `Input`, `Value` or the failure tag added.

The binding serves `POST` with `application/json` and screens requests as remote bindings must. A capability that declares `state` MAY also be served as a `Subscription` field.
