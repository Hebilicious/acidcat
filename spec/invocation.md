# Invocation

An **invocation** is one call to one capability. The client gives the id of the capability and an input. The client can cancel the call. Each call ends exactly one time, with one **outcome**.

## Outcomes

| Outcome | Meaning | JSON form |
| --- | --- | --- |
| Value | The capability did the operation | `{ "ok": true, "value": <output> }` |
| Failure | The capability did not do the operation, for a reason in its `failures` | `{ "ok": false, "error": <failure> }` |
| Call failure | The call did not give a result | `{ "kind": <kind>, "message": <text> }` |

A value and a failure are both **results**. A failure is data. A binding MUST send a failure to the client as a result. It MUST NOT send a failure as a call failure.

A binding MAY show outcomes in its own form, for example as exit codes, HTTP status codes or exceptions. A client MUST be able to identify each outcome and each kind of call failure. If a binding has no form of its own, it uses the JSON forms above. [`schemas/outcome.schema.json`](../schemas/outcome.schema.json) defines them.

## Call failures

| Kind | When |
| --- | --- |
| `cancelled` | The call stopped before it ended. The client, the session or the provider stopped it |
| `unknown-capability` | The id is not in the view of the target |
| `unavailable` | The capability is in the view, but it cannot run now. The message gives the reason |
| `invalid-input` | The input does not agree with the input schema |
| `internal` | All other problems, for example a defect in the provider |

If more than one kind applies, use the first kind in the table.

- The provider MUST validate the input before it starts the operation.
- An `unknown-capability` failure MUST NOT show if the id exists for a different target.
- The message of an `internal` failure MUST NOT show internal data. The provider SHOULD record the full cause for operators.
- Messages are for people. Clients identify call failures by `kind`.

## Availability

In a session, each capability in the view is available or unavailable:

- `{ "available": true }`
- `{ "available": false, "reason": <text> }`

Availability can change at any time. A session MUST decide each call on the availability at the moment that the call comes in. A binding that lists capabilities lists only the available capabilities, or it shows the availability of each one.

## Sessions

A **session** is one period in which one client calls the capabilities of one target. Each binding decides when its sessions open and close. For example, the MCP binding opens one session for each request.

- A session serves one client. A provider MUST NOT give the calls of two clients the same session. When a session closes, it cancels all its calls, and each client must keep its calls when a different client goes away.
- An input MUST NOT contain identity data, credentials or tokens. The session holds the identity of its client.
- A session is **open**, then **closing**, then **closed**. When a session starts to close, it accepts no new calls and cancels its work. A call after this time fails as `cancelled`.
- A provider MAY give sessions the services that it needs, for example authentication or storage. This specification does not define these services.

## Cancellation and concurrency

- Each call ends exactly one time. A call never gets the outcome of a different call.
- When a client cancels a call, only that call stops. Work that other calls wait for continues.
- When a call arrives during other work, the provider decides what to do. It can run the two at the same time, join them, reject the new call, replace the old work, or stop the old work.
- If the provider uses a failure to reject or replace a call, that failure MUST be in `failures`.
- A `cancelled` outcome does not tell if the work had an effect. If the effects of a capability can stay after a cancellation, its description MUST say so.

## Long work

A call ends when its work is complete. There is no polling and no time limit.

- A binding MAY send progress messages.
- A binding MAY stop waiting after a time limit. Then the call ends as `cancelled`.
- A capability MAY start work and return immediately. Then a different capability, or the state, shows the progress.

## State

A capability with `state` has a value that a client can read and follow. Examples are the status of a device, or the progress of long work. Each language binding tells how to read state and how to get its changes. A protocol binding MAY omit state.

## Design notes

*This section is not normative.*

- **Why three outcomes.** A client must know the difference between "the capability said no" and "the call did not run". Failures are data that the client can act on. Call failures are problems with the call.
- **Why the provider controls concurrency.** Different operations need different rules. The specification gives guarantees to each caller, and lets the provider choose the rules.
