---
title: Conformance
description: acid-cat check tests a catalog. acid-cat conform tests a running implementation from the outside, through each surface.
sidebar:
  order: 17
---

Conformance is a test from the outside. It uses the catalog and the behavior of each surface, and it does not look at the code. An implementation that you write by hand, that you generate, or that uses a library is tested in the same way.

Two commands of `@acid-cat/cli` do the tests:

| Command | Tests |
| --- | --- |
| `acid-cat check` | A catalog |
| `acid-cat conform` | A running provider and its surfaces |

## Check a catalog

```sh
acid-cat check --strict aircon.acidcat.json
```

A catalog conforms when it matches the JSON Schema of catalogs and follows the rules that the schema cannot express. For example:

- each target in each audience is in `targets`;
- no id is both a capability and an event;
- each input and each payload is an object;
- each `$ref` refers to a type in `$defs`;
- each alias of the command line follows the rules of the CLI surface.

`check` reports two levels. An **error** is a broken rule. A **warning** is a broken recommendation, for example a catalog that is not in canonical form. The exit code is 1 with errors. With `--strict`, warnings also give the exit code 1.

## Test an implementation

`acid-cat conform` does not test your catalog. It tests an implementation of the **conformance fixture**: a catalog in which each capability and each event shows one behavior. For example, `fixture.echo` returns its input, `fixture.refuse` returns a failure, `fixture.crash` fails with a defect, and `fixture.hold` waits until the test cancels it.

You serve the fixture with your core, and give each surface to `conform`:

```sh
acid-cat conform --mcp http://127.0.0.1:3000/mcp --http http://127.0.0.1:3000/api \
  --cli "node cli.ts" --mcp-stdio "node mcp.ts" \
  --webmcp http://127.0.0.1:3000/page
```

Through each surface, `conform` tests the list of capabilities, each outcome and each kind of call failure, availability, cancellation, events and their occurrences, and the rejections of remote surfaces. A failed check of a SHOULD rule gives a warning and passes. The exit code is 1 if a check fails.

Each core in the repository runs `acid-cat conform` in its tests. A core in another language does the same.

## Test an application

For your own application, test the capabilities through a session, and each surface through its own clients. Use `conform` when you write a new core or a new surface.

## Read more

- [Test an implementation with acid-cat conform](/docs/guides/test-with-conform/)
- [The acid-cat command](/docs/reference/cli/)
- [Conformance](/spec/conformance/) in the specification: every rule, the fixture and every check.
