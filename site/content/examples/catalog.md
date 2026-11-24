---
title: The catalog in each language
description: The catalog of the air conditioner, written in each catalog language. Each source writes the same canonical JSON.
sidebar:
  order: 1
  label: Catalog
tableOfContents: false
---

The catalog lists the targets, the types, the capabilities and the events of the air conditioner. <FileLink file="catalog/aircon.pkl" /> is the source. Each other source writes the same bytes with the catalog library of its language, and the tests compare each output with <FileLink file="catalog/aircon.acidcat.json" />.

<CatalogSources />

Write the canonical JSON from the Pkl source, from the root of the repository:

```sh
moon run examples
```

<CodeExplorer open="catalog/aircon.pkl" />

See [Write a catalog](/docs/guides/write-a-catalog/) for each part of a catalog.
