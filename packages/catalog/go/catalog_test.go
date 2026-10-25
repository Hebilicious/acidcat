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
