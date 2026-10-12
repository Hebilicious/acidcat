# Concurrency

AcidCat imposes no queue. Each capability's owner decides what happens when a call arrives while other work is in flight. This section lists the policies an owner may choose and what each caller observes under them.

Closes divergence row D12.

## Policies

| Policy | The arriving call | The work already in flight |
| --- | --- | --- |
| Overlap | Runs alongside the work in flight | Unaffected |
| Join | Waits for the same work and receives its own outcome from it | Unaffected |
| Reject | Settles at once with an expected failure | Unaffected |
| Replace | Runs | Its calls settle as `cancelled`, or with an expected failure |
| Cancel | Is a capability of its own that stops the work, and receives its own result | Its calls settle as `cancelled`, or with an expected failure |

An owner may apply different policies to different capabilities, and to different states of its work.

An expected failure that one of these policies uses MUST be declared in the capability's error schema.

## Guarantees

- Every call settles exactly once. A call is never left pending because of another call, and it never receives an outcome that belongs to another call.
- Aborting one call's signal affects only that call. Work that other calls are waiting for continues.
- An owner may stop work that no caller is waiting for any more.
- A `cancelled` outcome does not tell the caller whether the work committed any effects. A capability whose effects may survive cancellation says so in its description.

## Rationale

*This section is not normative.*

**Every policy comes from JB.** History pages overlap. Atlas reads join one load, and aborting one reader leaves the load running for the others. OCR review rejects with `resource/busy`. A new market fetch replaces the one in flight, and plan cancellation stops generation. HS's check machine replaces the check in flight.

**Replace may report either outcome.** JB's market fetch settles a replaced call with a tagged `market/fetch-replaced`, while JB's plan generation and HS's check settle it as an interruption. Both are honest, and the tagged failure gives the caller more to act on. The specification allows both rather than change working contracts. The Lean model will state the guarantees above for every policy.

**Effects after cancellation.** HS's check keeps running after its caller aborts, and still appends to the history. JB's owners send a correlated cancel and decide the commit point themselves. Neither leaves the caller able to assume that nothing happened, so the specification says so. Idempotent retries remain an open gap.

**Changes for each implementation.** Neither has to change. In HS, two `primes.check` calls in one session replace each other, and that includes calls in a single RPC batch. This is a legitimate replace policy, but it should be described in the capability.
