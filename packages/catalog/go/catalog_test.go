package catalog_test

import (
	"encoding/json"
	"math"
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/Hebilicious/acidcat/packages/catalog/go"
	"github.com/Hebilicious/acidcat/packages/catalog/go/examples/garage"
)

func TestWritesTheGarageCatalogInCanonicalForm(t *testing.T) {
	rendered, err := garage.Catalog().Render()
	if err != nil {
		t.Fatal(err)
	}
	expectBytes(t, rendered, "examples/garage/garage.acidcat.json")
}

func TestWritesEveryValueOfTheSharedTestCatalog(t *testing.T) {
	input, err := os.ReadFile("../testdata/canonical.json")
	if err != nil {
		t.Fatal(err)
	}
	var document map[string]any
	if err := json.Unmarshal(input, &document); err != nil {
		t.Fatal(err)
	}
	text, err := catalog.CanonicalText(document)
	if err != nil {
		t.Fatal(err)
	}
	expectBytes(t, text, "../testdata/canonical.acidcat.json")
}

// JSON gives Go only float64 numbers, so the integer types are written here.
func TestWritesGoIntegersAbove2To53AsFloats(t *testing.T) {
	text, err := catalog.CanonicalText(map[string]any{"x-integers": []any{
		int(9007199254740992), int(9007199254740993), int64(-9007199254740993), int64(math.MaxInt64),
	}})
	if err != nil {
		t.Fatal(err)
	}
	want := "{\n  \"x-integers\": [\n    9007199254740992,\n    9007199254740992,\n    -9007199254740992,\n    9223372036854776000\n  ]\n}\n"
	if text != want {
		t.Fatalf("got\n%s", text)
	}
}

func TestReportsTheRulesACatalogBreaks(t *testing.T) {
	c := catalog.New("", "").
		Target("cli", catalog.Target{Bindings: []string{"cli"}}).
		Capability("Bad.Id", catalog.Capability{Description: "x"}).
		Capability("a.b", catalog.Capability{Description: "y", Audience: []string{"clii"}}).
		Capability("a.c", catalog.Capability{Description: "z", Input: catalog.Schema{"type": "string"}}).
		Capability("a.d", catalog.Capability{Description: "w", Output: catalog.Schema{"$ref": "#/$defs/Nope"}})
	want := []string{
		"the id Bad.Id is malformed",
		"a.b names the undeclared target clii",
		"a.c input does not describe an object",
		"a.d references #/$defs/Nope, which is not a type",
	}
	if got := c.Validate(); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	if _, err := c.Render(); err == nil || !strings.Contains(err.Error(), "does not conform") {
		t.Fatalf("Render should refuse a catalog that breaks a rule, got %v", err)
	}
}

func TestReportsTheRulesAnEventBreaks(t *testing.T) {
	c := catalog.New("", "").Target("cli", catalog.Target{Bindings: []string{"cli"}})
	name := c.Type("Name", catalog.Schema{"type": "string"})
	c.
		Capability("a.b", catalog.Capability{Description: "x"}).
		Event("a.b", catalog.Event{Description: "y"}).
		Event("a.c", catalog.Event{Description: "z", Audience: []string{"clii"}, Input: catalog.Schema{"type": "string"}}).
		Event("a.d", catalog.Event{Description: "w", Payload: name}).
		Event("a.e", catalog.Event{Description: "v", Payload: catalog.Schema{"type": "object", "$defs": catalog.Schema{}}})
	want := []string{
		"a.b is both a capability and an event",
		"a.c names the undeclared target clii",
		"a.c input does not describe an object",
		"a.d payload does not describe an object",
		"a.e carries its own $defs; declare shared types with Type",
	}
	if got := c.Validate(); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestReportsATypeThatIsNotAnObject(t *testing.T) {
	c := catalog.New("", "").Target("cli", catalog.Target{Bindings: []string{"cli"}})
	c.Type("Nothing", nil)
	c.Capability("a.d", catalog.Capability{Description: "z", Output: catalog.Schema{"type": "object", "additionalProperties": false, "items": true}})
	want := []string{"the type Nothing is not a JSON object"}
	if got := c.Validate(); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
}

func TestWritesTheHintsOfACapabilityInCanonicalOrder(t *testing.T) {
	rendered, err := catalog.New("", "").
		Target("agents", catalog.Target{Bindings: []string{"mcp"}}).
		Capability("notes.count.read", catalog.Capability{
			State:       catalog.Schema{"type": "integer"},
			Idempotent:  new(true),
			Destructive: new(false),
			ReadOnly:    true,
			Audience:    []string{"agents"},
			Description: "Read the number of notes.",
		}).
		Render()
	if err != nil {
		t.Fatal(err)
	}
	expectBytes(t, rendered, "../testdata/hints.acidcat.json")
}

func expectBytes(t *testing.T, rendered, path string) {
	t.Helper()
	expected, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if rendered != string(expected) {
		t.Fatalf("the rendered catalog differs from %s:\n%s", path, rendered)
	}
}
