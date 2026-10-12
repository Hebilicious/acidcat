# Conformance kit

Black-box checks that judge any implementation from outside, whatever its language. [Conformance](../spec/conformance.md) states what they cover:

- **Catalogs:** `acidcat check` from the [toolchain](../toolchain/README.md) already covers the catalog half.
- **Bindings:** through each binding a target lists, the target serves exactly its view, refuses every other id as unknown, never starts work on invalid input, and delivers every outcome in the form its binding defines.
- **Guarantees:** every call settles exactly once, and cancelling one call never settles another. These are checked with property-based tests against a fixture catalog that the kit supplies and that the implementation serves.

heb-stack and Jarette's Box are the first two implementations it must pass.
