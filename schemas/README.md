# Schemas

These JSON Schema 2020-12 documents are normative, together with the prose of the [specification](../spec/README.md).

| Schema | Validates |
| --- | --- |
| [`catalog.schema.json`](catalog.schema.json) | A catalog or a view (see [Catalog](../spec/catalog.md)) |
| [`outcome.schema.json`](outcome.schema.json) | The JSON form of an outcome (see [Invocation](../spec/invocation.md#outcomes)) |
| [`occurrence.schema.json`](occurrence.schema.json) | The JSON form of an occurrence (see [Events](../spec/events.md#occurrences)) |

The catalog schema checks a document's shape. [Conformance](../spec/conformance.md#catalog) lists the rules it cannot express, such as the rule that an audience names only declared targets.
