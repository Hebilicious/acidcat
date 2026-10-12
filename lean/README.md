# Lean model

A Lean 4 model of the semantics: catalog, namespaces, audience, availability, `Result`, and the owner lifecycle as a transition system.

What it should prove:

- a session never lists or runs a capability outside its target's audience;
- input is always decoded before a computation runs;
- under each owner policy (overlap, reject, replace, cancel), what a caller observes is determined;
- cancelling one call never settles another caller's call.

The model is executable, and it generates the test vectors that `conformance/` replays against implementations. Start it once rows D2, D9 and D12 of the divergence inventory are closed.
