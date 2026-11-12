package catalog_test

import (
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

// edgeCatalog holds numbers and strings that Go writes differently from the canonical form by default.
func edgeCatalog() *catalog.Catalog {
	return catalog.New("", "").
		Target("console", catalog.Target{Bindings: []string{"cli"}}).
		Capability("edge.strings.echo", catalog.Capability{
			Description: "Text: \"said\", D:\\logs, tab\t, vt\v, soh\u0001, us\u001f, <&>, ls\u2028, ç, 🚗.",
			Audience:    []string{"console"},
			Output: catalog.Schema{
				"type": "object",
				"qKey": "q",
				"cKey": "c",
				"properties": catalog.Schema{
					"ç": catalog.Schema{"type": "string"},
					"Ç": catalog.Schema{"type": "string"},
					"c": catalog.Schema{"type": "string"},
					"_": catalog.Schema{"type": "string"},
					"9": catalog.Schema{"type": "string"},
					"10": catalog.Schema{"type": "string"},
				},
				"examples": []any{map[string]any{
					"whole": 42.0, "fifth": 0.2, "tiny": 1.25e-9, "small": 0.000015, "large": 3e25,
					"big": 271828182845904500000.0, "negative": -6.25e-15, "zero": 0.0, "integer": 64,
				}},
			},
		})
}

func TestWritesTheCanonicalFormOfEveryValue(t *testing.T) {
	rendered, err := edgeCatalog().Render()
	if err != nil {
		t.Fatal(err)
	}
	expectBytes(t, rendered, "testdata/edge.acidcat.json")
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

func TestPutsEventsAfterCapabilitiesAndTheMembersOfAnEventInOrder(t *testing.T) {
	text, err := catalog.CanonicalText(map[string]any{
		"events": map[string]any{
			"z.b.changed": map[string]any{"payload": map[string]any{"type": "object"}, "input": map[string]any{"type": "object"}, "description": "b"},
			"z.a.changed": map[string]any{"description": "a"},
		},
		"capabilities": map[string]any{},
		"targets":      map[string]any{},
		"acidcat":      "0.1",
	})
	if err != nil {
		t.Fatal(err)
	}
	want := `{
  "acidcat": "0.1",
  "targets": {},
  "capabilities": {},
  "events": {
    "z.a.changed": {
      "description": "a"
    },
    "z.b.changed": {
      "description": "b",
      "input": {
        "type": "object"
      },
      "payload": {
        "type": "object"
      }
    }
  }
}
`
	if text != want {
		t.Fatalf("got\n%s", text)
	}
}

func TestACatalogWithNoEventsHasNoEventsMember(t *testing.T) {
	text, err := catalog.New("", "").
		Target("cli", catalog.Target{Bindings: []string{"cli"}}).
		Capability("a.b", catalog.Capability{Description: "x", Audience: []string{"cli"}}).
		Render()
	if err != nil {
		t.Fatal(err)
	}
	if strings.Contains(text, `"events"`) {
		t.Fatalf("the catalog has an events member:\n%s", text)
	}
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
