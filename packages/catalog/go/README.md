# github.com/Hebilicious/acidcat/packages/catalog/go

The AcidCat catalog library for Go. Go module: `github.com/Hebilicious/acidcat/packages/catalog/go`.

Write a catalog in Go, and write it in canonical form. The library uses only the standard library. Use it at build time to write `acidcat.catalog.json`.

```sh
go get github.com/Hebilicious/acidcat/packages/catalog/go
```

The name of the Go package is `catalog`. Import it with `import "github.com/Hebilicious/acidcat/packages/catalog/go"`, and use it as `catalog`.

```go
c := catalog.New("Living-room air conditioner", "")
c.Target("cli", catalog.Target{Bindings: []string{"cli"}})
offline := c.Type("Offline", catalog.Schema{"type": "object"})
c.Capability("aircon.power.set", catalog.Capability{
	Description: "Turn the unit on or off.",
	Audience:    []string{"cli"},
	Input:       catalog.Schema{"type": "object", "required": []any{"on"}, "properties": catalog.Schema{"on": catalog.Schema{"type": "boolean"}}},
	Failures:    map[string]catalog.Schema{"Offline": offline},
})

text, err := c.Render()
```

`Validate()` lists the rules a catalog breaks, and `Render()` returns an error for one that breaks any. The full example is [`examples/aircon/aircon.go`](examples/aircon/aircon.go). Test with `moon run catalog-go:test`.
