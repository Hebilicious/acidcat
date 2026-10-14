# acid-cat-catalog (Pkl)

The AcidCat catalog module for [Pkl](https://pkl-lang.org). Pkl package: `package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog`.

Write a catalog in Pkl. The module checks the catalog rules while you write. Render the catalog to JSON with `pkl eval`, then put it in canonical form with `acid-cat format --write`.

```pkl
amends "package://pkg.pkl-lang.org/github.com/Hebilicious/acidcat/acid-cat-catalog@0.1.0#/Catalog.pkl"

targets {
  ["cli"] { bindings { "cli" } }
}

capabilities {
  ["aircon.power.set"] {
    description = "Turn the unit on or off."
    audience { "cli" }
  }
}
```

```sh
pkl eval aircon.pkl --output-path aircon.acidcat.json
acid-cat format --write aircon.acidcat.json
```

In this repository, the examples amend [`Catalog.pkl`](Catalog.pkl) by its path. `moon run catalog-pkl:test` packages the module into `.out/`.
