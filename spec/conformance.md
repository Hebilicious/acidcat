# Conformance

Conformance is a test from outside. It uses the catalog and the behavior of each binding. It does not look at the code. Thus an implementation that you write by hand, that you generate, or that uses a library is tested in the same way.

`acid-cat check` tests a catalog. `acid-cat conform` tests a provider and its bindings. Both come from [`@acid-cat/cli`](../packages/cli/README.md).

## Catalog

A catalog conforms if:

- it agrees with [`schemas/catalog.schema.json`](../schemas/catalog.schema.json);
- each target in each audience is in `targets`;
- each input is an object, directly or through the type that it refers to;
- each `$ref` refers to a type in `$defs`;
- no schema in a capability has its own `$defs`;
- each schema is a valid JSON Schema 2020-12 schema.

A catalog that is not in [canonical form](catalog.md#canonical-form) gets a warning. A member that this specification does not define and that does not start with `x-` gets a warning.

## Provider and bindings

A provider and its bindings conform for a target if, through each binding of the target:

- a list of capabilities shows only capabilities in the view of the target;
- a call to an id that is not in the view fails as a call to an unknown id;
- an input that does not agree with its schema fails as `invalid-input`, and the operation does not start;
- values, failures and state agree with their schemas;
- each outcome and each kind of call failure has the form that the binding defines;
- a remote binding rejects requests as [Remote bindings](bindings/README.md#remote-bindings) tells.

The tests use a test catalog to examine behavior such as rejection and replacement.

A test that a SHOULD rule fails gives a warning, not an error. Tests that need access to the code, for example of internal logs, are not part of conformance.
