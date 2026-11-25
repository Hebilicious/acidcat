---
title: API
description: The functions that the package exports.
---

The package exports these functions. Each one has types.

## `defineConfig`

Gives the type of the configuration object, and returns it unchanged.

```ts
function defineConfig(config: Config): Config;
```

| Parameter | Type | Required |
| --- | --- | --- |
| `config` | `Config` | Yes |

### Example

```ts
import { defineConfig } from "example-docs";

const result = await defineConfig(/* ... */);
console.log(result);
```

The function does not change its arguments. It throws an error with a message that names the file and the line when the input is not valid.

## `build`

Builds the site into the output folder, and returns the list of the files that it wrote.

```ts
function build(options: BuildOptions): Promise<BuildResult>;
```

| Parameter | Type | Required |
| --- | --- | --- |
| `options` | `BuildOptions` | Yes |

### Example

```ts
import { build } from "example-docs";

const result = await build(/* ... */);
console.log(result);
```

The function does not change its arguments. It throws an error with a message that names the file and the line when the input is not valid.

## `serve`

Starts the development server, and reloads the page in the browser on each change.

```ts
function serve(options: ServeOptions): Promise<Server>;
```

| Parameter | Type | Required |
| --- | --- | --- |
| `options` | `ServeOptions` | Yes |

### Example

```ts
import { serve } from "example-docs";

const result = await serve(/* ... */);
console.log(result);
```

The function does not change its arguments. It throws an error with a message that names the file and the line when the input is not valid.

## `loadPages`

Reads each Markdown file of the folder of the pages, and returns its route and its data.

```ts
function loadPages(root: string): Promise<Page[]>;
```

| Parameter | Type | Required |
| --- | --- | --- |
| `root` | `string` | Yes |

### Example

```ts
import { loadPages } from "example-docs";

const result = await loadPages(/* ... */);
console.log(result);
```

The function does not change its arguments. It throws an error with a message that names the file and the line when the input is not valid.

## `renderPage`

Renders one page to HTML, with the layout of the site.

```ts
function renderPage(page: Page): Promise<string>;
```

| Parameter | Type | Required |
| --- | --- | --- |
| `page` | `Page` | Yes |

### Example

```ts
import { renderPage } from "example-docs";

const result = await renderPage(/* ... */);
console.log(result);
```

The function does not change its arguments. It throws an error with a message that names the file and the line when the input is not valid.

## `createSearchIndex`

Makes the index that the search box reads, from the text of each page.

```ts
function createSearchIndex(pages: Page[]): SearchIndex;
```

| Parameter | Type | Required |
| --- | --- | --- |
| `pages` | `Page[]` | Yes |

### Example

```ts
import { createSearchIndex } from "example-docs";

const result = await createSearchIndex(/* ... */);
console.log(result);
```

The function does not change its arguments. It throws an error with a message that names the file and the line when the input is not valid.

## `resolveLink`

Returns the route that a link leads to, or `undefined` when no page has that route.

```ts
function resolveLink(from, to: string, string): string | undefined;
```

| Parameter | Type | Required |
| --- | --- | --- |
| `from, to` | `string, string` | Yes |

### Example

```ts
import { resolveLink } from "example-docs";

const result = await resolveLink(/* ... */);
console.log(result);
```

The function does not change its arguments. It throws an error with a message that names the file and the line when the input is not valid.

## `slugify`

Returns the id of a heading from its text.

```ts
function slugify(text: string): string;
```

| Parameter | Type | Required |
| --- | --- | --- |
| `text` | `string` | Yes |

### Example

```ts
import { slugify } from "example-docs";

const result = await slugify(/* ... */);
console.log(result);
```

The function does not change its arguments. It throws an error with a message that names the file and the line when the input is not valid.
