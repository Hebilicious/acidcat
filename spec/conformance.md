# Conformance

An implementation conforms when it passes the conformance kit. The kit judges an implementation from outside, by its manifests and by how it behaves on the wire, so it treats an implementation written by hand exactly like one built on the reference library.

Closes divergence row D17.

## What the kit checks

**Manifests**, for each target the implementation serves:

- the document's shape, from [Manifest](manifest.md);
- the grammar and uniqueness of ids, from [Identifiers](identifiers.md);
- that every input schema is an object, every error schema is made of tagged variants with distinct tags, and every array is bounded ([Collections](collections.md#bounds));
- that, when the implementation serves `web`, the `web` manifest lists every capability that any other manifest lists ([The page](targets.md#the-page)).

**Behaviour**, through each binding:

- that a listing holds only ids from the target's manifest;
- that a call to an id outside the target's manifest fails exactly as a call to an id that does not exist does;
- that input which does not conform fails as `invalid-input`;
- that results conform to the output and error schemas;
- that every outcome and every invocation failure kind arrives as the binding defines it;
- that requests are screened as [Remote transports](transport.md) requires.

Behaviour that depends on a particular domain, such as rejecting or replacing work, is checked against a fixture catalog that the kit supplies and that the implementation serves.

## What stays elsewhere

- **In-process checks** belong to the test suite of the reference implementation. These include that the catalog walk groups leaves by namespace, that the manifest is regenerated from the source schemas, that defects are logged, and that disposal withdraws registrations.
- **Product evidence** belongs to each application. JB's Product Promise manifests, its reverse index of capability ids and its orphan checks, and HS's Gherkin features, test what an application promises, not what AcidCat requires.

## Rationale

*This section is not normative.*

**The kit is black-box.** Most of JB's catalog-conformance suite and every HS target proof check a manifest or wire behaviour: ids, descriptions, schema shapes, bounded arrays, listings, refusal of unknown tools, transport statuses. Those checks move into the kit. The rest, which needs root sessions, a recording port or the source schemas, is in-process and moves to the reference implementation.

**The fixture catalog.** Without knowing a domain, the kit cannot provoke an expected failure, a rejection or a replacement. A small fixture catalog that every implementation can serve on a test stage makes those checks generic.

**Product Promises stay in JB.** JB's reverse index ties product promises to capability ids. That is a useful practice, but it is about JB's product rather than about AcidCat. The reference implementation may offer it as a tool.
