# Conformance

Conformance is judged from outside: from the catalog, and from what each binding does on its surface. An implementation written by hand, generated, or built on a reference library conforms the same way.

## Catalog

A catalog conforms when it validates against [`schemas/catalog.schema.json`](../schemas/catalog.schema.json) and follows the rules in [Catalog](catalog.md) that the schema cannot express:

- every audience entry is a declared target;
- every input describes an object, either directly or through the type it references;
- every `$ref` names a type in the catalog's `$defs`, and no schema inside a capability carries `$defs` of its own;
- every schema compiles once [bundled](catalog.md#bundling).

A committed catalog that is not in [canonical form](catalog.md#canonical-form) gets a warning. [`acidcat check`](../packages/toolchain/README.md) applies all of these.

## Provider and bindings

A provider and its bindings conform for a target when, through each binding that the target lists:

- the listing shows only capabilities in the target's view;
- a call to an id outside the view fails exactly as a call to an id that does not exist;
- an input that does not conform fails as `invalid-input`, and the work never starts;
- values, failures and state conform to their schemas;
- every outcome, and every kind of call failure, arrives as the binding defines it;
- a remote binding screens requests as [remote bindings](bindings/README.md#remote-bindings) must.

Behaviour that depends on a domain, such as rejecting or replacing work, is checked against a fixture catalog that the conformance kit supplies.

The kit checks the bindings this specification defines. It reports a SHOULD that is not met as a warning, not a failure. Tests that need access to the code (internal logging, how a root is composed) belong to each implementation's own suite. Product evidence, such as Jarette's Box's Product Promises, belongs to each application.
