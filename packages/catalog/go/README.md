# acid-cat.dev/catalog

The AcidCat catalog library for Go, published as the module `acid-cat.dev/catalog`.

Write a catalog in Go and render it in canonical form. Standard library only, and no runtime role: run it at build time to produce `acidcat.catalog.json`.

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
