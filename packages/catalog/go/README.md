# github.com/Hebilicious/acidcat/packages/catalog/go

The AcidCat catalog library for Go, published as the Go module `github.com/Hebilicious/acidcat/packages/catalog/go`. Build a catalog in code and write it in [canonical form](../../../spec/catalog.md#canonical-form). The library uses only the standard library. Use it at build time to write `acidcat.catalog.json`.

## Install

```sh
go get github.com/Hebilicious/acidcat/packages/catalog/go
```

The Go package is named `catalog`. Import it with `import "github.com/Hebilicious/acidcat/packages/catalog/go"` and refer to it as `catalog`.

## Example

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
c.Event("garage.door.moved", catalog.Event{
	Description: "The door started or stopped. The occurrence gives the position of the door.",
	Audience:    []string{"phone"},
	Input:       catalog.Schema{"type": "object", "properties": catalog.Schema{}},
	Payload:     catalog.Schema{"type": "object", "properties": catalog.Schema{"position": catalog.Schema{"type": "string"}}},
})

text, err := c.Render()
```

The full example, a garage door, is [`examples/garage/garage.go`](examples/garage/garage.go).

## API

- `Event` declares an [event](../../../spec/events.md). Clients subscribe to it and get its payload in each occurrence. A payload is an object, or a reference to a type that is an object.
- `ReadOnly`, `Destructive` and `Idempotent` are a capability's [hints](../../../spec/catalog.md#capabilities) for clients. `Destructive` and `Idempotent` are `*bool`: write `new(true)` or `new(false)`, or leave them nil. A hint you leave out is not in the catalog.
- `Validate()` lists the rules that the catalog breaks. `Render()` returns an error for a catalog that breaks any rule.

## Tests

Run `moon run catalog-go:test`. The tests compare the library's output, byte for byte, with these files:

| File | Contents |
| --- | --- |
| [`examples/garage/garage.acidcat.json`](examples/garage/garage.acidcat.json) | The garage-door catalog |
| [`../testdata/canonical.acidcat.json`](../testdata/canonical.acidcat.json) | The canonical form of [`../testdata/canonical.json`](../testdata/canonical.json): values that languages write differently by default |
| [`../testdata/hints.acidcat.json`](../testdata/hints.acidcat.json) | Each hint of a capability, in canonical order |

The air-conditioner example writes its catalog with this library in [`examples/aircon/catalog/go`](../../../examples/aircon/catalog/go), and its test compares the output with the Pkl catalog. The root `moon run check` checks that each committed catalog file is in canonical form.
