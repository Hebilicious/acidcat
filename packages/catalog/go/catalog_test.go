package catalog_test

import (
	"os"
	"reflect"
	"strings"
	"testing"

	"github.com/Hebilicious/acidcat/packages/catalog/go"
	"github.com/Hebilicious/acidcat/packages/catalog/go/examples/aircon"
)

func TestWritesTheSameAirconCatalogAsPkl(t *testing.T) {
	rendered, err := aircon.Catalog().Render()
	if err != nil {
		t.Fatal(err)
	}
	expectBytes(t, rendered, "../../../examples/aircon.acidcat.json")
}

func TestWritesTheCanonicalFormOfEveryValue(t *testing.T) {
	c := catalog.New("", "").
		Target("cli", catalog.Target{Bindings: []string{"cli"}}).
		Capability("edge.case.check", catalog.Capability{
			Description: "Strings: \"quoted\", back\\slash, tab\t, é, \u2028, \u0001, 😀.",
			Audience:    []string{"cli"},
			Output: catalog.Schema{
				"type": "object",
				"zKey": "last",
				"aKey": "first",
				"properties": catalog.Schema{
					"é": catalog.Schema{"type": "string"},
					"z": catalog.Schema{"type": "string"},
					"Z": catalog.Schema{"type": "string"},
				},
				"examples": []any{map[string]any{
					"whole": 16.0, "half": 0.5, "tiny": 1e-7, "small": 0.000001, "large": 1e21,
					"big": 123456789012345680000.0, "negative": -2.5e-10, "zero": 0.0, "integer": 42,
				}},
			},
		})
	rendered, err := c.Render()
	if err != nil {
		t.Fatal(err)
	}
	expectBytes(t, rendered, "../fixtures/edge.acidcat.json")
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
