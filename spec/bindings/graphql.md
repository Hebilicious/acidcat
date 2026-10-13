# GraphQL binding

A protocol binding that serves a view as a GraphQL schema. The schema comes from the catalog. The binding follows the rules for [remote bindings](README.md#remote-bindings).

## Schema

- **Names.** Each capability is a root field. Its name is the segments of the id in camelCase: `aircon.power.set` becomes `airconPowerSet`. A `readOnly` capability is a field of `Query`. Other capabilities are fields of `Mutation`.
- **Input.** The field has one argument, `input`. Its type comes from the input schema. If GraphQL cannot show the schema correctly, the type is the `JSON` scalar.
- **Outcomes.** The field returns a union: one type for the value, and one type for each failure tag. `__typename` identifies the type. If the output is not an object, the value type has one field, `value`, that contains the value. Each failure type has the field `_tag`. A call failure is a GraphQL error. Its `extensions.kind` is the kind, and the field is `null`.
- **Listing.** `Query.acidcatCapabilities` gives the `id`, `available` and `reason` of each capability. A deployment MAY also give the view as `Query.acidcatCatalog: JSON!`.
- **Calls by id.** `Mutation.acidcatInvoke(id: String!, input: JSON): JSON!` gives the outcome in its JSON form.
- **Cancellation.** When the client stops the request, its calls are cancelled.

Each type in `$defs` becomes a GraphQL type with the same name. Other types get the `title` of their schema. If there is no `title`, they get the name of the field followed by `Input`, `Value` or the failure tag.

The binding accepts `POST` with `application/json`. A capability that has `state` MAY also be a `Subscription` field.
