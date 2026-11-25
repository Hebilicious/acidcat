---
title: Deployment
description: Build the site and put it on a static host.
---

The build writes a static site into `dist/`. Any static host serves it.

## Build the site

:::tabs
== pnpm
```sh
pnpm docs:build
```
== npm
```sh
npm run docs:build
```
== Yarn
```sh
yarn docs:build
```
:::

## Upload the folder

Upload `dist/` to the host. Set the host to send `404.html` for each path that has no file.
