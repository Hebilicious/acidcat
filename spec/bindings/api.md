# API binding

This binding serves the `api` target to programs. It defines three operations independently of any protocol, then gives one concrete profile over HTTP and JSON. REST, GraphQL, RPC or any other protocol can carry the same operations. The binding depends on [Targets](../targets.md), [Manifest](../manifest.md), [Invocation](../invocation.md) and [Remote transports](../transport.md).

## Operations

| Operation | Answers |
| --- | --- |
| `manifest()` | The `api` [manifest](../manifest.md) |
| `list()` | For each capability in the manifest: its `id`, `available`, and the availability's `reason` when it is not available |
| `invoke(id, input)` | The invocation's outcome, as one of the three JSON values in [Invocation](../invocation.md) |

A **projection** carries these operations over a protocol. A projection conforms when it provides all three operations, names capabilities by their ids, and keeps every outcome distinguishable. When a client cancels a request, the invocation's signal is aborted.

A projection MAY also offer typed entry points for each capability, such as a GraphQL field, a REST resource or a typed RPC method. They MUST be generated from the catalog, the way every other binding is, and each one answers exactly as `invoke` would.

## HTTP profile

This profile serves the operations as JSON over HTTP, under a base URL that the deployment chooses:

| Request | Operation |
| --- | --- |
| `GET {base}/manifest` | `manifest()` |
| `GET {base}/capabilities` | `list()` |
| `POST {base}/capabilities/{id}`, with the input as the body | `invoke(id, input)` |

A result, whether a success or an expected failure, answers `200`. The body's `ok` member tells the two apart. An invocation failure answers with its own status:

| Kind | Status |
| --- | --- |
| `unknown-capability` | 404 |
| `invalid-input` | 422 |
| `cancelled` | 409, when the client is still there to receive it |
| `unavailable` | 503 |
| `internal` | 500 |

The profile applies [Remote transports](../transport.md#screening), using statuses 405, 403, 415, 413 and 400 for the screens, in the order they are listed there.

## Other projections

*This section is not normative.*

- **GraphQL.** Generate one root field for each capability, named after its id. Put `readOnly` capabilities under `Query` and the rest under `Mutation`. Return the result as a union of the success type and the failure variants, and report invocation failures as GraphQL errors with `extensions.kind`. Add `manifest`, `capabilities` and a generic `invoke(id, input)` so that every capability can also be reached by id.
- **RPC.** Expose `manifest`, `list` and `invoke` as methods, and optionally a typed method for each capability. HS's capnweb API becomes one of these once it gains the generic methods.
- **REST resources.** A deployment that prefers resource-style URLs can generate them from ids, for example `GET` for `readOnly` capabilities with the input in the query string. It keeps the HTTP profile's statuses and bodies.

## Rationale

*This section is not normative.*

**One API, many protocols.** Programs reach an application over whatever protocol suits them. A binding tied to one RPC library would make every other protocol its own binding. Defining the operations once lets REST, GraphQL and RPC differ only in how they carry them, and the conformance kit can test the operations through any projection.

**A concrete HTTP profile.** Clients and the conformance kit need one default they can rely on without negotiating anything. Plain JSON over HTTP is the lowest common denominator.

**`200` for expected failures.** An expected failure is data that the capability declared, not an HTTP error. Invocation failures get statuses so that generic HTTP tooling, such as retries, caches and logs, treats them sensibly.

**The target is `api`, not `rpc`.** Its clients are programs. The protocol they use belongs to the projection, not to the audience.

**Changes for each implementation.**
- HS: rename the target `rpc` to `api`, and add `manifest`, `list` and `invoke` to the capnweb API. Its `check` and `next` methods may stay as typed methods, provided they are generated.
- JB: none. Its RPC endpoints (the optimiser and auth) are outside AcidCat.
