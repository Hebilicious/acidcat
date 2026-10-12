# AcidCat SDK for Go

Write a catalog in Go and render it to JSON. Standard library only, and no runtime role: run it at build time to produce `acidcat.catalog.json`.

```go
catalog := acidcat.New("Living-room air conditioner", "")
catalog.Target("cli", acidcat.Target{Bindings: []string{"cli"}})
offline := catalog.Type("Offline", acidcat.Schema{"type": "object"})
catalog.Capability("aircon.power.set", acidcat.Capability{
	Description: "Turn the unit on or off.",
	Audience:    []string{"cli"},
	Input:       acidcat.Schema{"type": "object", "required": []any{"on"}, "properties": acidcat.Schema{"on": acidcat.Schema{"type": "boolean"}}},
	Failures:    map[string]acidcat.Schema{"Offline": offline},
})

text, err := catalog.Render()
```

`Validate()` lists the rules a catalog breaks, and `Render()` returns an error for one that breaks any. The full example is [`examples/aircon/aircon.go`](examples/aircon/aircon.go). Test with `go -C sdk/go test ./...`.
