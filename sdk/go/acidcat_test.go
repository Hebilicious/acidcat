package acidcat_test

import (
	"encoding/json"
	"os"
	"reflect"
	"strings"
	"testing"

	acidcat "acidcat.dev/sdk/go"
	"acidcat.dev/sdk/go/examples/aircon"
)

func TestWritesTheSameAirconCatalogAsPkl(t *testing.T) {
	rendered, err := aircon.Catalog().Render()
	if err != nil {
		t.Fatal(err)
	}
	expected, err := os.ReadFile("../../examples/aircon.acidcat.json")
	if err != nil {
		t.Fatal(err)
	}
	var got, want any
	if err := json.Unmarshal(rendered, &got); err != nil {
		t.Fatal(err)
	}
	if err := json.Unmarshal(expected, &want); err != nil {
		t.Fatal(err)
	}
	if !reflect.DeepEqual(got, want) {
		t.Fatalf("the catalog differs from examples/aircon.acidcat.json:\n%s", rendered)
	}
}

func TestReportsTheRulesACatalogBreaks(t *testing.T) {
	catalog := acidcat.New("", "").
		Target("cli", acidcat.Target{Bindings: []string{"cli"}}).
		Capability("Bad.Id", acidcat.Capability{Description: "x"}).
		Capability("a.b", acidcat.Capability{Description: "y", Audience: []string{"clii"}}).
		Capability("a.c", acidcat.Capability{Description: "z", Input: acidcat.Schema{"type": "string"}}).
		Capability("a.d", acidcat.Capability{Description: "w", Output: acidcat.Schema{"$ref": "#/$defs/Nope"}})
	want := []string{
		"the id Bad.Id is malformed",
		"a.b names the undeclared target clii",
		"a.c input does not describe an object",
		"a.d references #/$defs/Nope, which is not a type",
	}
	if got := catalog.Validate(); !reflect.DeepEqual(got, want) {
		t.Fatalf("got %q, want %q", got, want)
	}
	if _, err := catalog.Render(); err == nil || !strings.Contains(err.Error(), "does not conform") {
		t.Fatalf("Render should refuse a catalog that breaks a rule, got %v", err)
	}
}
