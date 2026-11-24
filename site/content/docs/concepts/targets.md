---
title: Targets
description: A target is a group of clients, and what they can use. Each surface of a target serves only the catalog of the target.
sidebar:
  order: 13
---

A **target** is a group of clients, and what they can use, for example `app`, `cli` or `mcp`. The catalog lists the surfaces of each target. The **catalog of a target** is the part of the catalog that its clients can use. Each surface serves the catalog of its target, and nothing more.

## Targets in the air conditioner

The air conditioner has five targets: `app`, `taskbar`, `cli`, `mcp` and `api`. Here are three of them:

<CatalogExample target="app,cli,mcp" />

| Member | Required | Value |
| --- | --- | --- |
| `surfaces` | Yes | The surfaces that serve the target |
| `description` | No | The clients of the target |
| `options` | No | Settings for the surfaces, in a member with the name of the surface. For example, `options.cli` holds the aliases of the command line |

- You choose the target names. The specification reserves none.
- A target can use more than one surface. A web page can use `typescript` and `webmcp`.
- A surface that the specification does not define has a prefix, such as `acme:swift`.

## The catalog of a target

The catalog of a target is itself a catalog. It contains:

- only that target in `targets`;
- only the capabilities and the events whose audience includes that target;
- only the types that these capabilities and events use.

In the air conditioner, the `taskbar` target sees only `aircon.status.get`, `aircon.power.set` and the event `aircon.status.changed`. The `mcp` target does not see `aircon.status.export` or `aircon.firmware.update`.

Print the catalog of one target with `acid-cat target`:

```sh
acid-cat target aircon.acidcat.json mcp
```

## Outside the target

A client gets no information about a capability or an event outside its target. A call to such a capability fails as a call to an unknown id, `unknown-capability`. The failure is the same when the id exists for a different target, so a client cannot learn about it.

In the air conditioner, the MCP servers, WebMCP and the APIs answer `unknown-capability` for `aircon.status.export`.

## Choose targets for agents

Give agents only the capabilities that they must have. Put the `mcp` target, and each target with the `webmcp` surface, only in the audience of those capabilities.

## Read more

- [Catalog: targets](/spec/catalog/#targets) and [Catalog: the catalog of a target](/spec/catalog/#the-catalog-of-a-target) in the specification.
- [Surfaces](/docs/concepts/surfaces/), the ways that clients reach a target.
