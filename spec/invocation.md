# Invocation

An **invocation** calls one capability in a session. It names the capability by id, supplies an input, can be cancelled, and settles exactly once with an **outcome**.

## Outcomes

| Outcome | Meaning | JSON form |
| --- | --- | --- |
| Value | The capability did what was asked | `{ "ok": true, "value": <output> }` |
| Failure | The capability declined in a way its catalog entry declares | `{ "ok": false, "error": <failure> }` |
| Call failure | The call produced no result | `{ "kind": <kind>, "message": <text> }` |

A value and a failure together form the **result**. A failure is data, so a binding MUST deliver it to the client as a result and never as a call failure.

A binding MAY represent outcomes in its own form, such as exit codes, HTTP statuses, exceptions or a language's union types. Whatever the form, a client MUST be able to tell every outcome, and every kind of call failure, apart. Where a binding has no form of its own, it uses the JSON forms above, which [`schemas/outcome.schema.json`](../schemas/outcome.schema.json) defines.

## Call failures

| Kind | Reported when |
| --- | --- |
| `cancelled` | The call was cancelled before it settled: by its client, by its session closing, or by the provider replacing or stopping the work |
| `unknown-capability` | The id is not in the target's view, whether the catalog does not hold it or the capability's audience does not name the target |
| `unavailable` | The capability is in the view but cannot run now. The message is the availability's reason |
| `invalid-input` | The input does not conform to the capability's input schema |
| `internal` | Anything else, such as a defect in the provider |

When more than one kind applies, the first one in the table is reported.

- The provider MUST NOT start the work until the input has been validated.
- An `unknown-capability` failure MUST NOT reveal whether the id exists for another target.
- The message of an `internal` failure MUST NOT reveal internal details. The provider SHOULD record the full cause where operators can read it.
- Messages are written for people. Clients tell call failures apart by `kind`.

## Availability

In a session, each capability in the view is either available, or unavailable with a reason: `{ "available": true }` or `{ "available": false, "reason": <text> }`. Availability can change at any time. Bindings that list capabilities list only the available ones, or mark each one's availability.

## Sessions

A session is the context that a client's invocations run in. Each binding decides how long its sessions last.

- Inputs MUST NOT carry identity, credentials or tokens. A session closes over its client's identity, and the provider sees that identity through the session.
- A session is **open**, then **closing**, then **closed**. When it starts closing, it stops admitting calls and cancels its signal, and its work then settles or is cancelled. A call made after closing has begun fails as `cancelled`.
- A provider MAY give sessions any services it needs, such as authentication, storage or navigation. This specification does not define them.

## Cancellation and concurrency

- Every call settles exactly once. A call never receives another call's outcome.
- Cancelling one call affects only that call. Work that other calls are waiting for continues.
- When a call arrives while other work is in flight, the provider decides what happens. It may run them alongside each other, join them to the same work, reject the new call, replace the work, or stop it. A failure used for a rejection or a replacement MUST be declared in `failures`.
- A `cancelled` outcome does not tell the client whether the work had any effect. A capability whose effects can survive cancellation says so in its description.

## Long work

A call settles when its work is done, however long that takes. There is no polling protocol and no execution timeout in the core. A binding MAY report progress, and MAY bound how long it waits, in which case the call ends as `cancelled`. A capability MAY start work and return straight away, leaving another capability, or its state, to report how the work is going.

## State

A capability that declares `state` exposes a value that a client can read and then follow as it changes. It might be the unit's current status, or the progress of some long work. Each language binding defines how to read and subscribe to state. A protocol binding MAY leave state out.

## Rationale

*This section is not normative.*

**The outcomes come from both implementations.** Jarette's Box and heb-stack both validate input before anything runs. Both return failures as tagged results and throw for invalid input, cancellation and defects, keeping defects private. This section names those cases so that every binding keeps them apart.

**Concurrency is the provider's business.** Each owner in Jarette's Box chooses its own policy: history overlaps, atlas reads join one load, OCR rejects when it is busy, market fetches replace each other. Constraining providers would only take choices away. Callers need guarantees about their own call, and this section lists exactly those.

**State is optional.** UI clients need live values, and both kernels expose snapshots that can be observed. Agents and APIs usually don't, so a protocol binding can ignore state.
