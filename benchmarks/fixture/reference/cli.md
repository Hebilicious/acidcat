---
title: Command line
description: The commands of example-docs and their options.
---

The command line has three commands.

| Command | Use |
| --- | --- |
| `example-docs dev` | Serves the site with live reload |
| `example-docs build` | Builds the static site into `dist/` |
| `example-docs check` | Checks each link and each code block |

## Options

| Option | Commands | Use |
| --- | --- | --- |
| `--port <number>` | `dev` | The port of the server. The default is 5173 |
| `--out <folder>` | `build` | The output folder. The default is `dist` |
| `--strict` | `check` | Fails on a warning |

## Examples

```sh
example-docs dev --port 3000
example-docs build --out public
example-docs check --strict
```
