# acid-cat-catalog (Pkl)

The AcidCat catalog module for [Pkl](https://pkl-lang.org), published as the Pkl package `package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog`. The module checks the catalog rules while you write. Render the catalog to JSON with `pkl eval`, then put it in [canonical form](../../../spec/catalog.md#canonical-form) with `acid-cat format --write`.

## Example

<!-- x-release-please-start-version -->

```pkl
amends "package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog@0.3.0#/Catalog.pkl"

targets {
  ["panel"] { bindings { "typescript" } }
}

capabilities {
  ["greenhouse.vents.set"] {
    description = "Open the roof vents to a percentage."
    audience { "panel" }
  }
}

events {
  ["greenhouse.tank.low"] {
    description = "The rain-water tank fell below a level. The occurrence gives the litres that are left."
    audience { "panel" }
    payload {
      type = "object"
      properties { litres { type = "number" } }
    }
  }
}
```

<!-- x-release-please-end -->

Render it and format it:

```sh
pkl eval greenhouse.pkl --output-path greenhouse.acidcat.json
acid-cat format --write greenhouse.acidcat.json
```

The full example, a greenhouse, is [`examples/greenhouse.pkl`](examples/greenhouse.pkl). It amends [`Catalog.pkl`](Catalog.pkl) by its path. Its canonical JSON is [`examples/greenhouse.acidcat.json`](examples/greenhouse.acidcat.json).

## Module

- `readOnly`, `destructive` and `idempotent` on a capability are its [hints](../../../spec/catalog.md#capabilities) for clients.
- `events` declares the [events](../../../spec/events.md) that clients can subscribe to. The module checks that each audience names a target, that each input and payload is an object or a reference, and that no event id is also a capability id.
- `cli` on a target gives the options of the [command line](../../../spec/bindings/cli.md#aliases) and renders as `options.cli`. The classes `CliOptions` and `CliAlias` reject a misspelled member name. `acid-cat check` checks the alias rules.

A target with two aliases and a default:

```pkl
["cli"] {
  bindings { "cli" }
  cli {
    aliases {
      ["vents"] { capability = "greenhouse.vents.set" }
      ["--open"] { capability = "greenhouse.vents.set"; input { percent = 100 } }
    }
    default = "vents"
  }
}
```

## Tests

`moon run catalog-pkl:test` packages the module into `.out/`, then evaluates the example, which checks the example's catalog rules. The package does not contain the example.

The root `moon run check` renders each `.pkl` catalog that has an `.acidcat.json` file beside it and compares the two. It also checks that each committed catalog file is in canonical form.
