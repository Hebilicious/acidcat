# acid-cat-catalog (Pkl)

The AcidCat catalog module for [Pkl](https://pkl-lang.org). Pkl package: `package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog`.

Write a catalog in Pkl. The module checks the catalog rules while you write. Render the catalog to JSON with `pkl eval`, then put it in canonical form with `acid-cat format --write`.

```pkl
amends "package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog@0.1.0#/Catalog.pkl"

targets {
  ["panel"] { bindings { "typescript" } }
}

capabilities {
  ["greenhouse.vents.set"] {
    description = "Open the roof vents to a percentage."
    audience { "panel" }
  }
}
```

```sh
pkl eval greenhouse.pkl --output-path greenhouse.acidcat.json
acid-cat format --write greenhouse.acidcat.json
```

The full example is [`examples/greenhouse.pkl`](examples/greenhouse.pkl), a greenhouse. It amends [`Catalog.pkl`](Catalog.pkl) by its path. Its canonical JSON is [`examples/greenhouse.acidcat.json`](examples/greenhouse.acidcat.json). The root `moon run check` renders each `.pkl` catalog that has an `.acidcat.json` file beside it, and compares the two. It also checks that each committed catalog file is in [canonical form](../../../spec/catalog.md#canonical-form).

`moon run catalog-pkl:test` packages the module into `.out/`, then evaluates the example. The package does not contain the example. The evaluation checks the catalog rules of the example.
