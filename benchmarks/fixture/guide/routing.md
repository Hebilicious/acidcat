---
title: Routing
description: How files become routes, and how links between pages work.
---

This page is long. It tells how the tool turns files into routes, and how pages link to each other.

## Files and routes

Each Markdown file in the folder of the pages is a route. The path of the file, without its extension, is the path of the route.

The rule is simple, so a reader can find the file of a page from its address, and the address of a page from its file. A tool or a script can do the same without reading the configuration.

Keep the names of the files short and lowercase. Use a hyphen between words. Do not rename a file without a redirect, because readers and search engines keep the old address.

```ts
// Example 1
const routes = pages.map((file) => ({
  path: toRoute(file),
  component: () => import(file),
}));
```

## Index files

A file named `index.md` is the route of its folder. `guide/index.md` is the route `/guide/`.

The rule is simple, so a reader can find the file of a page from its address, and the address of a page from its file. A tool or a script can do the same without reading the configuration.

Keep the names of the files short and lowercase. Use a hyphen between words. Do not rename a file without a redirect, because readers and search engines keep the old address.

### Example

| File | Route |
| --- | --- |
| `index.md` | `/` |
| `guide/index.md` | `/guide/` |
| `guide/routing.md` | `/guide/routing/` |

## Nested folders

A folder in a folder is a path with more segments. The tool follows folders to any depth.

The rule is simple, so a reader can find the file of a page from its address, and the address of a page from its file. A tool or a script can do the same without reading the configuration.

Keep the names of the files short and lowercase. Use a hyphen between words. Do not rename a file without a redirect, because readers and search engines keep the old address.

## Trailing slashes

Each route ends with a slash. The host serves the HTML file of the folder for that path.

The rule is simple, so a reader can find the file of a page from its address, and the address of a page from its file. A tool or a script can do the same without reading the configuration.

Keep the names of the files short and lowercase. Use a hyphen between words. Do not rename a file without a redirect, because readers and search engines keep the old address.

```ts
// Example 4
const routes = pages.map((file) => ({
  path: toRoute(file),
  component: () => import(file),
}));
```

## Links between pages

A link to another page uses the path of its route. The build checks that each link leads to a page.

The rule is simple, so a reader can find the file of a page from its address, and the address of a page from its file. A tool or a script can do the same without reading the configuration.

Keep the names of the files short and lowercase. Use a hyphen between words. Do not rename a file without a redirect, because readers and search engines keep the old address.

## Links to headings

Each heading has an id. A link to a heading adds the id after a hash: `/guide/routing/#index-files`.

The rule is simple, so a reader can find the file of a page from its address, and the address of a page from its file. A tool or a script can do the same without reading the configuration.

Keep the names of the files short and lowercase. Use a hyphen between words. Do not rename a file without a redirect, because readers and search engines keep the old address.

### Example

| File | Route |
| --- | --- |
| `index.md` | `/` |
| `guide/index.md` | `/guide/` |
| `guide/routing.md` | `/guide/routing/` |

## Pages that are not routes

A file whose name starts with an underscore is not a route. Use it for parts that other pages include.

The rule is simple, so a reader can find the file of a page from its address, and the address of a page from its file. A tool or a script can do the same without reading the configuration.

Keep the names of the files short and lowercase. Use a hyphen between words. Do not rename a file without a redirect, because readers and search engines keep the old address.

```ts
// Example 7
const routes = pages.map((file) => ({
  path: toRoute(file),
  component: () => import(file),
}));
```

## The 404 page

The file `404.md` is the page for each path that has no route. The host must send it with the status 404.

The rule is simple, so a reader can find the file of a page from its address, and the address of a page from its file. A tool or a script can do the same without reading the configuration.

Keep the names of the files short and lowercase. Use a hyphen between words. Do not rename a file without a redirect, because readers and search engines keep the old address.

## Redirects

A page can move. Keep its old path in the list of redirects, so old links still work.

The rule is simple, so a reader can find the file of a page from its address, and the address of a page from its file. A tool or a script can do the same without reading the configuration.

Keep the names of the files short and lowercase. Use a hyphen between words. Do not rename a file without a redirect, because readers and search engines keep the old address.

## Generated routes

A plugin can add routes from data, for example one page for each package of a monorepo.

The rule is simple, so a reader can find the file of a page from its address, and the address of a page from its file. A tool or a script can do the same without reading the configuration.

Keep the names of the files short and lowercase. Use a hyphen between words. Do not rename a file without a redirect, because readers and search engines keep the old address.

```ts
// Example 10
const routes = pages.map((file) => ({
  path: toRoute(file),
  component: () => import(file),
}));
```

### Example

| File | Route |
| --- | --- |
| `index.md` | `/` |
| `guide/index.md` | `/guide/` |
| `guide/routing.md` | `/guide/routing/` |

## Order of the sidebar

The sidebar lists the routes in the order of the configuration. A route that is not in the list is not in the sidebar.

The rule is simple, so a reader can find the file of a page from its address, and the address of a page from its file. A tool or a script can do the same without reading the configuration.

Keep the names of the files short and lowercase. Use a hyphen between words. Do not rename a file without a redirect, because readers and search engines keep the old address.

## Base path

A site that is not served at the root of its domain sets `base`. Each route then starts with that path.

The rule is simple, so a reader can find the file of a page from its address, and the address of a page from its file. A tool or a script can do the same without reading the configuration.

Keep the names of the files short and lowercase. Use a hyphen between words. Do not rename a file without a redirect, because readers and search engines keep the old address.
