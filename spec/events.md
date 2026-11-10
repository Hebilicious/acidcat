# Events

An **event** is a kind of thing that happens in an application, and that clients can follow, for example `aircon.status.changed`. The catalog declares each event in [`events`](catalog.md#events). A client **subscribes** to an event with an input. Then the provider sends an **occurrence** each time that the thing happens, until the subscription ends.

A **subscription** is one client following one event with one input. It is like an [invocation](invocation.md) that gives many values instead of one.

## Subscribing

The client gives the id of the event and an input. It can also give a cursor (see [Resuming](#resuming)).

- The provider MUST validate the input before it starts the subscription.
- If the subscription cannot start, it fails with a [call failure](invocation.md#call-failures) before the first occurrence:

  | Kind | When |
  | --- | --- |
  | `cancelled` | The client, the session or the provider stopped the subscription before it started |
  | `unknown-capability` | The id is not an event in the view of the target |
  | `invalid-input` | The input does not agree with the input schema of the event |
  | `internal` | All other problems |

  If more than one kind applies, use the first kind in the table. The rules for the messages of call failures apply.

- An `unknown-capability` failure MUST NOT show if the event exists for a different target.
- Events have no availability. An event in the view can always start a subscription.

## Occurrences

| Member | Required | Value |
| --- | --- | --- |
| `eventId` | Yes | A string that identifies the thing that happened. Clients use it to find a duplicate occurrence in one subscription |
| `name` | Yes | The id of the event |
| `timestamp` | Yes | When the thing happened, as an RFC 3339 date and time in UTC, for example `2026-11-10T09:30:00Z` |
| `data` | Yes | The payload. It MUST agree with the payload schema of the event |
| `cursor` | No | The position of the subscription after this occurrence. See [Resuming](#resuming) |
| `truncated` | No | `true` if the provider skipped occurrences before this one |

[`schemas/occurrence.schema.json`](../schemas/occurrence.schema.json) defines this JSON form. A binding MAY show an occurrence in its own form. The client MUST be able to read each member.

- The provider SHOULD give the `eventId` of the source of the event, if the source has one. If the provider gives none, the binding makes one that is unique in the subscription.
- If the provider gives no `timestamp`, the binding uses the time at which it sends the occurrence.
- In one subscription, the occurrences come in the order in which the provider gives them. There is no order between two subscriptions.

## Ending

A subscription ends exactly one time, in one of these ways:

| End | When | The client sees |
| --- | --- | --- |
| Complete | The provider has no more occurrences, or the session closes | The normal end of the stream |
| Cancelled | The client stops the subscription | Nothing more. The binding does not have to tell the client |
| Call failure | The provider fails during the subscription, or it gives an occurrence that does not agree with the payload schema | The call failure `internal`, after the occurrences before it |

- When a subscription ends, the provider stops its work for that subscription, and releases the resources.
- The message of an `internal` failure MUST NOT show internal data.

## Sessions and concurrency

- A session can hold any number of subscriptions at the same time, and calls at the same time as subscriptions.
- When a client cancels one subscription, only that subscription ends. Other subscriptions and calls continue.
- When a session starts to close, each of its subscriptions ends as complete. A subscription that starts after this time fails as `cancelled`.
- A subscription never gets an occurrence of a different subscription.

## Slow clients

A client can read occurrences slower than the provider gives them.

- The binding keeps the occurrences that the client has not read, up to a limit of the deployment.
- When the limit is full, the binding removes the oldest occurrences. The next occurrence that the client reads has `"truncated": true`.

## Resuming

A **cursor** is a string that tells a position in the occurrences of an event. Only the provider can read it.

- A provider MAY give a cursor with each occurrence. An event that gives cursors SHOULD give a cursor with each occurrence.
- A client MAY give a cursor when it subscribes. The provider then starts after that position, and sends the occurrences after it. If the provider cannot start at that position, it starts at a later position, and the first occurrence has `"truncated": true`.
- A client MAY also give `maxAgeMs`, a number of milliseconds. The provider then sends no occurrence that is older than that time. If this skips occurrences, the first occurrence has `"truncated": true`.
- With no cursor, the subscription starts now. The provider sends no occurrence from before the subscription.
- A provider that gives no cursors ignores the cursor and `maxAgeMs` of the client.

## Design notes

*This section is not normative.*

- **Why events are not capabilities.** A capability gives one outcome. An event gives a stream of occurrences that only the client or the end of the session stops. The two have different surfaces in most protocols: a tool and an event stream in MCP, a request and a stream of server-sent events in HTTP, a mutation and a subscription in GraphQL.
- **Why the session closes subscriptions as complete.** A GraphQL subscription ends with "complete" when the server ends it. A client then knows that the stream is done, and does not report an error.
- **Why the members of an occurrence.** They are the members of an event occurrence in the MCP events extension. Thus the MCP binding sends the occurrence without change, and all bindings use one form.
- **Why no failures.** A thing that went wrong in the source is an occurrence too. Put it in the payload, for example as a union with a `_tag`. A call failure is only for problems with the subscription itself.
