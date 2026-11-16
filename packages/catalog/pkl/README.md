# acid-cat-catalog (Pkl)

The AcidCat catalog module for [Pkl](https://pkl-lang.org). Pkl package: `package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog`.

Write a catalog in Pkl. The module checks the catalog rules while you write. Render the catalog to JSON with `pkl eval`, then put it in canonical form with `acid-cat format --write`.

<!-- x-release-please-start-version -->

```pkl
amends "package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog@0.2.1#/Catalog.pkl"

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

```sh
pkl eval greenhouse.pkl --output-path greenhouse.acidcat.json
acid-cat format --write greenhouse.acidcat.json
```

`events` declares the [events](../../../spec/events.md) that clients can subscribe to. The module checks that each audience names a target, that each input and payload is an object or a reference, and that no id is also the id of a capability.

The member `cli` of a target gives the options of the [command line](../../../spec/bindings/cli.md#aliases), and renders as `options.cli`. Its classes `CliOptions` and `CliAlias` reject a misspelled member name. `acid-cat check` checks the rules of the aliases:

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

The full example is [`examples/greenhouse.pkl`](examples/greenhouse.pkl), a greenhouse. It amends [`Catalog.pkl`](Catalog.pkl) by its path. Its canonical JSON is [`examples/greenhouse.acidcat.json`](examples/greenhouse.acidcat.json). The root `moon run check` renders each `.pkl` catalog that has an `.acidcat.json` file beside it, and compares the two. It also checks that each committed catalog file is in [canonical form](../../../spec/catalog.md#canonical-form).

`moon run catalog-pkl:test` packages the module into `.out/`, then evaluates the example. The package does not contain the example. The evaluation checks the catalog rules of the example.
