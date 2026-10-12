# HTTP binding

A protocol binding that serves a view as JSON over HTTP, in a REST style that any HTTP client can use. It depends on [Catalog](../catalog.md), [Invocation](../invocation.md) and the rules for [remote bindings](README.md#remote-bindings).

## Requests

All paths are relative to a base URL that the deployment chooses:

| Request | Answer |
| --- | --- |
| `GET {base}/catalog` | The target's view. Optional: a deployment MAY serve it so that clients can discover the API |
| `GET {base}/capabilities` | A JSON array with one entry per capability in the view: its `id`, `available`, and `reason` when it is unavailable |
| `POST {base}/capabilities/{id}`, with the input as the body | The outcome |

- **Names.** The id appears in the path as it is.
- **Outcomes.** A result answers `200`, and its `ok` member tells a value from a failure. A call failure answers with the status below and the body `{ "kind", "message" }`.

  | Kind | Status |
  | --- | --- |
  | `unknown-capability` | 404 |
  | `invalid-input` | 422 |
  | `unavailable` | 503 |
  | `cancelled` | 409, when the client is still there to receive it |
  | `internal` | 500 |

- **Cancellation.** Closing the request cancels the call.
- **Screening.** The binding refuses requests with 405, 403, 415, 413 and 400, matching the [screens](README.md#remote-bindings) in the order they are listed there. The media type is `application/json`. Requests without an `Origin` header are accepted.

A deployment MAY add resource-style routes generated from ids, such as `GET` with the input in the query string for `readOnly` capabilities. They answer exactly as the `POST` route does.
