---
title: Installation
description: Install the tool with your package manager.
---

Install the tool as a development dependency of your project.

## Install the package

:::tabs
== pnpm
```sh
pnpm add --save-dev example-docs
```
== npm
```sh
npm install --save-dev example-docs
```
== Yarn
```sh
yarn add --dev example-docs
```
:::

## Add the scripts

Add two scripts to `package.json`: one to serve the site while you write, and one to build it.

```json
{
  "scripts": {
    "docs:dev": "example-docs dev",
    "docs:build": "example-docs build"
  }
}
```

## Start the server

:::tabs
== pnpm
```sh
pnpm docs:dev
```
== npm
```sh
npm run docs:dev
```
== Yarn
```sh
yarn docs:dev
```
:::

The server listens on port 5173. Open `http://localhost:5173` in a browser. The page reloads each time you save a file.
