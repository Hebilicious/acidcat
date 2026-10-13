# acid-cat.dev/catalog

The AcidCat catalog library for Go. Go module: `acid-cat.dev/catalog`.

Write a catalog in Go, and write it in canonical form. The library uses only the standard library. Use it at build time to write `acidcat.catalog.json`.

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
