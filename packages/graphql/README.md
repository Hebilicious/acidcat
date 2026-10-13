# @acid-cat/graphql

The AcidCat [GraphQL binding](../../spec/bindings/graphql.md). npm package: `@acid-cat/graphql`. Both AcidCat cores use it. It depends only on graphql-js, and has no Effect dependency.

| Export | Use |
| --- | --- |
| `graphqlSchema(view)` | The GraphQL schema of a view, as SDL text, with the operation of each capability |
| `executable(view)` | The executable schema. Make it one time |
| `execute(schema, provider, request, signal)` | Run one GraphQL request against a provider: `availability(id)` and `invoke(id, input, signal)` |
| `readRequest(request, options)` | Read a GraphQL request from HTTP, and reject requests as remote bindings tell |

Test with `moon run graphql:test`.
