# Schemas

JSON Schema 2020-12 documents, normative alongside the prose:

| Schema | Validates |
| --- | --- |
| [`catalog.schema.json`](catalog.schema.json) | A catalog or a view (see [Catalog](../spec/catalog.md)) |
| [`outcome.schema.json`](outcome.schema.json) | The JSON form of an outcome (see [Invocation](../spec/invocation.md#outcomes)) |

The catalog schema checks the document's shape. The rules it cannot express, such as an audience naming only declared targets, are listed in [Conformance](../spec/conformance.md#catalog).
