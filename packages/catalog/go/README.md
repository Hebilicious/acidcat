# github.com/Hebilicious/acidcat/packages/catalog/go

The AcidCat catalog library for Go. Go module: `github.com/Hebilicious/acidcat/packages/catalog/go`.

Write a catalog in Go, and write it in canonical form. The library uses only the standard library. Use it at build time to write `acidcat.catalog.json`.

```sh
go get github.com/Hebilicious/acidcat/packages/catalog/go
```

The name of the Go package is `catalog`. Import it with `import "github.com/Hebilicious/acidcat/packages/catalog/go"`, and use it as `catalog`.

```go
c := catalog.New("Garage door", "")
c.Target("phone", catalog.Target{Bindings: []string{"typescript"}})
obstructed := c.Type("Obstructed", catalog.Schema{"type": "object"})
c.Capability("garage.door.open", catalog.Capability{
	Description: "Open the door.",
	Audience:    []string{"phone"},
	Input:       catalog.Schema{"type": "object", "properties": catalog.Schema{"light": catalog.Schema{"type": "boolean"}}},
	Failures:    map[string]catalog.Schema{"Obstructed": obstructed},
})

text, err := c.Render()
```

`Validate()` lists the rules a catalog breaks, and `Render()` returns an error for one that breaks any. The full example is [`examples/garage/garage.go`](examples/garage/garage.go), a garage door.

The tests compare the output of the library with files in this directory: the garage-door catalog [`examples/garage/garage.acidcat.json`](examples/garage/garage.acidcat.json), and a catalog of values that languages write differently, [`testdata/edge.acidcat.json`](testdata/edge.acidcat.json). A test also compares [`examples/aircon/aircon.go`](examples/aircon/aircon.go) with the air-conditioner catalog of the repository. Each committed catalog file is in [canonical form](../../../spec/catalog.md#canonical-form), and the root `moon run check` checks this. Thus all catalog libraries agree on the canonical form, and they do not share a test file. Test with `moon run catalog-go:test`.
