# HTTP binding

A protocol binding that serves a view as JSON through HTTP. Any HTTP client can use it. It follows the rules for [remote bindings](README.md#remote-bindings).

## Requests

The deployment chooses a base URL. All paths are relative to it.

| Request | Answer |
| --- | --- |
| `GET {base}/capabilities` | A JSON array. Each item has the `id` of a capability in the view, `available`, and `reason` if the capability is unavailable |
| `POST {base}/capabilities/{id}` with the input as the body | The outcome |
| `GET {base}/catalog` | The view of the target. A deployment MAY serve this request |
| `GET {base}/events` | A JSON array. Each item has the `id` of an event in the view |
| `POST {base}/events/{id}` with the input as the body | A stream of [server-sent events](#events) |

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

## Events

`POST {base}/events/{id}` subscribes to an event. The body is the input.

- **Cursor.** The `Last-Event-ID` header gives the cursor. The `maxAgeMs` query parameter gives `maxAgeMs`, for example `?maxAgeMs=60000`.
- **Failures before the first occurrence.** The answer is a call failure, with the body `{ "kind", "message" }` and the status of the table above. The binding sends it before the stream starts.
- **Stream.** If the subscription starts, the answer has the status 200, the media type `text/event-stream`, and the header `Cache-Control: no-store`. The stream uses the framing of the "distinct connections" mode of the GraphQL over server-sent events protocol:

  | Message | Fields |
  | --- | --- |
  | An occurrence | `event: next`, `id: <cursor>` if the occurrence has a cursor, and `data:` with the JSON of the occurrence on one line |
  | Complete | `event: complete` and an empty `data:` field. Then the binding closes the stream |
  | `internal` | `event: error` and `data:` with `{ "kind": "internal", "message" }`. Then the binding closes the stream |

- **Keepalive.** The binding SHOULD send a comment line (`:`) when it has sent nothing for 15 seconds. The client ignores comment lines.
- **Cancellation.** When the client closes the stream, the subscription is cancelled.
- **Rejected requests.** The rules of [Requests](#requests) apply. The media type of the request is `application/json`.

A deployment MAY add routes that come from the ids. For example, `GET` with the input in the query string for a `readOnly` capability. These routes give the same answers as the `POST` route.
