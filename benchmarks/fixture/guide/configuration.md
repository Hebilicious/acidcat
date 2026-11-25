---
title: Configuration
description: The options of the configuration file.
---

The configuration file is `docs.config.ts`, at the root of the project. It exports one object.

```ts
import { defineConfig } from "example-docs";

export default defineConfig({
  title: "My project",
  description: "The documentation of my project.",
  base: "/",
  outDir: "dist",
});
```

## Options

| Option | Type | Default | Use |
| --- | --- | --- | --- |
| `title` | `string` | `"Docs"` | The title of the site, after the title of each page |
| `description` | `string` | `""` | The description of each page that has none |
| `base` | `string` | `"/"` | The path where the site is served |
| `outDir` | `string` | `"dist"` | The folder that the build writes |
| `lang` | `string` | `"en"` | The language of each page |

## Environment variables

The configuration can read environment variables. The build reads them once.

```ts
export default defineConfig({
  title: process.env.DOCS_TITLE ?? "My project",
});
```
