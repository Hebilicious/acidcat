# HTTP binding

A protocol binding that serves a view as JSON through HTTP. Any HTTP client can use it. It follows the rules for [remote bindings](README.md#remote-bindings).

## Requests

The deployment chooses a base URL. All paths are relative to it.

| Request | Answer |
| --- | --- |
| `GET {base}/capabilities` | A JSON array. Each item has the `id` of a capability in the view, `available`, and `reason` if the capability is unavailable |
| `POST {base}/capabilities/{id}` with the input as the body | The outcome |
| `GET {base}/catalog` | The view of the target. A deployment MAY serve this request. If a capability of the view does not [load](../invocation.md#loading-on-first-use), the answer is the call failure `internal` |

- **Names.** The id is in the path without change.
- **Outcomes.** A result has the status 200. Its `ok` member tells if it is a value or a failure. A call failure has the body `{ "kind", "message" }` and one of these statuses:

  | Kind | Status |
  | --- | --- |
  | `unknown-capability` | 404 |
  | `invalid-input` | 422 |
  | `unavailable` | 503 |
  | `cancelled` | 409, if the client still waits |
  | `internal` | 500 |

- **Cancellation.** When the client closes the request, the call is cancelled.
- **Rejected requests.** The binding uses 405, 403, 415, 413 and 400 for the problems in [Remote bindings](README.md#remote-bindings), in that order. The media type is `application/json`. The binding accepts requests that have no `Origin` header.

A deployment MAY add routes that come from the ids. For example, `GET` with the input in the query string for a `readOnly` capability. These routes give the same answers as the `POST` route.
