# Invocation

An **invocation** names a capability by its id, supplies an input, and may be cancelled. It settles exactly once, in one of three ways:

| Outcome | Meaning | Value |
| --- | --- | --- |
| Success | The capability produced its output | `{ "ok": true, "value": <output> }` |
| Expected failure | The capability failed in a way its contract declares | `{ "ok": false, "error": <failure> }` |
| Invocation failure | The invocation produced no result | `{ "kind": <kind>, "message": <text> }` |

Success and expected failure together form the **result**. Values cross a boundary in the encoded form that the manifest's schemas describe.

Closes divergence rows D11 and D13.

## Expected failures

An expected failure is a JSON object with a string member `_tag`. Each failure variant a capability declares has its own `_tag`, distinct from that capability's other variants.

An expected failure is a result, not an error of the invocation. A binding MUST deliver it to the caller as data.

## Invocation failures

| Kind | Reported when |
| --- | --- |
| `cancelled` | The call's own signal or its session's signal was aborted, or the computation was interrupted, before the invocation settled |
| `unknown-capability` | The session does not serve the id: the catalog does not hold it, or the session's target is outside its audience |
| `unavailable` | The capability is in the audience but is not available. The message is the availability's reason |
| `invalid-input` | The input does not decode with the capability's input schema |
| `internal` | Anything else, such as a defect in the computation or an output that cannot be encoded |

When more than one kind applies, the implementation reports the first one in the table.

The caller MUST NOT be able to tell an id outside its target's audience from an id that does not exist.

The computation MUST NOT start until the input has decoded. Availability is checked when the call is admitted, and an implementation MAY check it again just before the computation starts. Either check reports `unavailable`.

The message of an `internal` failure MUST NOT reveal internal details such as stack traces, causes or data. An implementation SHOULD record the full cause where operators can read it.

The message is meant for people and is not a stable value. Callers distinguish failures by `kind`.

A binding MUST map each outcome, and each invocation failure kind, onto its transport so that a caller can tell them apart.

## Long work

An invocation settles when its work is done, however long that takes. This specification defines no polling protocol and no execution timeout.

Several patterns fit within that rule, and an application chooses among them:

- A binding MAY report progress while a call runs, using whatever its protocol offers, such as MCP progress notifications.
- A binding or deployment MAY bound how long it waits, as an HTTP platform does. The call then ends as `cancelled`.
- A capability MAY start work and return straight away, leaving the owner to keep the work. Another capability reports how it is going, and a [snapshot](divergence.md#shared-core) can publish it.

## Rationale

*This section is not normative.*

**Both implementations already have these kinds.** Both decode input before anything runs, wrap undecodable input in an `InvocationInputFailure`, turn interruption into an `AbortError`, and report anything else as a generic "failed to execute" error, so defects stay internal. JB also has an `InvocationUnavailableFailure` for a capability that became unavailable during the call. The inventory recorded `InvocationInputFailure` as HS-only, but JB has it too. Neither one gives these failures names a caller can rely on on the wire. JB's MCP adapter, for example, returns them as a tool error carrying `{ message }`, which a client can tell from a capability's own failure only because `_tag` is missing.

**Unknown and out-of-audience look the same.** JB's spec says a leaf outside the audience is "absent" and "unknown to a direct call". If the two cases could be told apart, probing would reveal the catalog of other targets.

**Interruption is cancellation.** When an owner replaces or cancels work it holds, the caller whose work was superseded has no result, and that is cancellation from the caller's point of view. Row D12 specifies when owners do this. Defects are a separate kind, so a bug never reads as a cancellation.

**The order follows the code.** Both implementations check the signal first, then audience and availability, then decode the input. A cancelled answer does not depend on the id, so putting `cancelled` first reveals nothing.

**Long work keeps JB's rule and leaves room around it (row D11).** JB and HS both await the final result, and a single rule for every capability keeps callers simple. Progress, transport deadlines, and starting work then inspecting it are all still open to applications, so the rule does not dictate how anyone runs long work.

**In-process APIs are bindings.** The TypeScript handles throw `TypeError` and `AbortError`. That is how one binding represents these kinds, and it lives in `ref/ts/`.
