---
title: Use AcidCat with a coding agent
description: Install the acid-cat skill so that a coding agent writes catalogs, implements capabilities with a core, and tests them the AcidCat way.
sidebar:
  order: 26
  label: Coding agents
---

The repository publishes an agent skill, `acid-cat`. It teaches a coding agent to build with AcidCat: write the catalog, implement capabilities and events with a core, serve them through surfaces, and test them with `acid-cat check` and `acid-cat conform`.

## Install the skill

```sh
gh skill install Hebilicious/acidcat acid-cat
```

The agent uses the skill when a repository depends on `@acid-cat/*` or `acid-cat-core`, has a `*.acidcat.json` catalog or a Pkl module that amends `Catalog.pkl`, or when you ask it to add a capability, a target or a surface. It also uses the skill when you ask it to expose an application to agents through MCP or WebMCP, or to give it a command line or an HTTP API.

The source of the skill is [`skills/acid-cat/SKILL.md`](https://github.com/Hebilicious/acidcat/blob/main/skills/acid-cat/SKILL.md). Two references go with it: [`cores.md`](https://github.com/Hebilicious/acidcat/blob/main/skills/acid-cat/references/cores.md) for each core, and [`surfaces.md`](https://github.com/Hebilicious/acidcat/blob/main/skills/acid-cat/references/surfaces.md) for the options and the traps of each surface.

## What the skill tells the agent

- **The catalog is the contract.** Change the catalog first, then the code.
- **Prefer a source to JSON by hand.** When a catalog has a source, change the source, never the JSON.
- **Each audience is explicit.** Give agents only the capabilities that they must have.
- **Give the hints that are true.** `readOnly`, `destructive` and `idempotent` tell agent clients when to ask the user before a call.
- **A failure is data.** Declare each failure by tag, so that an agent can tell "the unit is offline" from a defect.
- **Inputs carry no identity.** The session holds the identity of the client.
- **Put each constraint in the schema.** Then the catalog, the agents and the validation agree.

## Ask for a change

With the skill installed, ask for the result that you want. For example:

```txt
Add a capability aircon.timer.set that turns the unit off after a number of minutes.
Give it to the app, cli and mcp targets.
```

The skill gives the agent the steps for a new capability:

1. Add it to the source of the catalog: id, description, audience, input, output, failures and hints.
2. Implement it in the core.
3. Write the JSON of the catalog again, and run `acid-cat check --strict`.
4. Run the tests of the application, and `acid-cat conform` for each surface that the application serves.

## Read machine output

`acid-cat check` and `acid-cat conform` take `--output json`. The report is then one JSON document on standard output, with the same exit code. An agent reads that document, not the text for people.

::: tip
A command line that a core builds writes JSON by default. When you set its default form to `auto`, it writes text for a person in a terminal, and JSON under a coding agent, in CI or in a pipe.
:::

## Read more

- [The acid-cat command](/docs/reference/cli/)
- [Capabilities](/docs/concepts/capabilities/) and [Targets](/docs/concepts/targets/)
