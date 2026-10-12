# Lean model

A Lean 4 model of the semantics: the catalog and its views, availability, outcomes, sessions, and provider concurrency as a transition system.

What it should prove:

- a binding never lists or runs a capability outside its target's view;
- input is always validated before any work starts;
- every call settles exactly once, under any provider policy (overlap, join, reject, replace, stop);
- cancelling one call never settles another caller's call.

The model is executable, and it generates the test vectors that `conformance/` replays against implementations.
