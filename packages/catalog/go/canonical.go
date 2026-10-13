package catalog

import (
	"fmt"
	"math"
	"slices"
	"strconv"
	"strings"
)

// The canonical form of a catalog (spec/catalog.md#canonical-form): the one way to write a catalog as text, so that
// every tool and every catalog library produces the same bytes for the same catalog.

var (
	catalogOrder    = []string{"acidcat", "title", "description", "targets", "$defs", "capabilities"}
	targetOrder     = []string{"bindings", "description", "options"}
	capabilityOrder = []string{"description", "audience", "input", "output", "failures", "readOnly", "state"}
)

// CanonicalText writes a catalog, given as JSON values (maps, slices, strings, numbers, booleans, nil), in
// canonical form.
func CanonicalText(catalog map[string]any) (string, error) {
	var out strings.Builder
	if err := write(&out, canonicalCatalog(catalog), ""); err != nil {
		return "", err
	}
	out.WriteByte('\n')
	return out.String(), nil
}

// ordered is an object whose members are written in the order of keys.
type ordered struct {
	keys   []string
	values map[string]any
}

func canonicalCatalog(catalog map[string]any) ordered {
	return orderedBy(catalog, catalogOrder, func(key string, value any) any {
		switch key {
		case "targets":
			return byKey(value, func(target any) any {
				return orderedBy(asObject(target), targetOrder, func(_ string, inner any) any { return sorted(inner) })
			})
		case "$defs":
			return byKey(value, sorted)
		case "capabilities":
			return byKey(value, func(capability any) any {
				return orderedBy(asObject(capability), capabilityOrder, func(member string, inner any) any {
					if member == "failures" {
						return byKey(inner, sorted)
					}
					return sorted(inner)
				})
			})
		}
		return sorted(value)
	})
}

func orderedBy(value map[string]any, order []string, each func(string, any) any) ordered {
	var keys, others []string
	for _, key := range order {
		if _, ok := value[key]; ok {
			keys = append(keys, key)
		}
	}
	for key := range value {
		if !slices.Contains(order, key) {
			others = append(others, key)
		}
	}
	slices.Sort(others)
	keys = append(keys, others...)
	values := make(map[string]any, len(keys))
	for _, key := range keys {
		values[key] = each(key, value[key])
	}
	return ordered{keys, values}
}

func byKey(value any, each func(any) any) ordered {
	object := asObject(value)
	keys := sortedKeys(object)
	values := make(map[string]any, len(keys))
	for _, key := range keys {
		values[key] = each(object[key])
	}
	return ordered{keys, values}
}

func sorted(value any) any {
	switch v := value.(type) {
	case map[string]any:
		return byKey(v, sorted)
	case []any:
		items := make([]any, len(v))
		for i, item := range v {
			items[i] = sorted(item)
		}
		return items
	case []string:
		items := make([]any, len(v))
		for i, item := range v {
			items[i] = item
		}
		return items
	}
	return value
}

func asObject(value any) map[string]any {
	switch v := value.(type) {
	case map[string]any:
		return v
	case map[string]Schema:
		object := make(map[string]any, len(v))
		for key, inner := range v {
			object[key] = inner
		}
		return object
	}
	return map[string]any{}
}

func write(out *strings.Builder, value any, indent string) error {
	inner := indent + "  "
	switch v := value.(type) {
	case ordered:
		if len(v.keys) == 0 {
			out.WriteString("{}")
			return nil
		}
		out.WriteString("{\n")
		for i, key := range v.keys {
			if i > 0 {
				out.WriteString(",\n")
			}
			out.WriteString(inner)
			writeString(out, key)
			out.WriteString(": ")
			if err := write(out, v.values[key], inner); err != nil {
				return err
			}
		}
		out.WriteString("\n" + indent + "}")
	case map[string]any:
		return write(out, byKey(v, sorted), indent)
	case []any:
		if len(v) == 0 {
			out.WriteString("[]")
			return nil
		}
		out.WriteString("[\n")
		for i, item := range v {
			if i > 0 {
				out.WriteString(",\n")
			}
			out.WriteString(inner)
			if err := write(out, item, inner); err != nil {
				return err
			}
		}
		out.WriteString("\n" + indent + "]")
	case []string:
		return write(out, sorted(v), indent)
	case nil:
		out.WriteString("null")
	case bool:
		out.WriteString(strconv.FormatBool(v))
	case string:
		writeString(out, v)
	case int:
		out.WriteString(strconv.Itoa(v))
	case int64:
		out.WriteString(strconv.FormatInt(v, 10))
	case float64:
		text, err := number(v)
		if err != nil {
			return err
		}
		out.WriteString(text)
	default:
		return fmt.Errorf("a catalog holds only JSON values, not %T", value)
	}
	return nil
}

// writeString escapes a string exactly as ECMAScript's JSON.stringify does.
func writeString(out *strings.Builder, text string) {
	out.WriteByte('"')
	for _, r := range text {
		switch r {
		case '"':
			out.WriteString(`\"`)
		case '\\':
			out.WriteString(`\\`)
		case '\b':
			out.WriteString(`\b`)
		case '\f':
			out.WriteString(`\f`)
		case '\n':
			out.WriteString(`\n`)
		case '\r':
			out.WriteString(`\r`)
		case '\t':
			out.WriteString(`\t`)
		default:
			if r < 0x20 {
				fmt.Fprintf(out, `\u%04x`, r)
			} else {
				out.WriteRune(r)
			}
		}
	}
	out.WriteByte('"')
}

// number writes a number the way ECMAScript's Number::toString does, from its shortest round-trip digits.
func number(value float64) (string, error) {
	if math.IsNaN(value) || math.IsInf(value, 0) {
		return "", fmt.Errorf("a catalog holds only finite numbers")
	}
	if value == 0 {
		return "0", nil
	}
	sign := ""
	if value < 0 {
		sign = "-"
		value = -value
	}
	// FormatFloat(…, 'e', -1, 64) gives the shortest digits that round-trip, as d.ddde±x.
	mantissa, exponentText, _ := strings.Cut(strconv.FormatFloat(value, 'e', -1, 64), "e")
	exponent, _ := strconv.Atoi(exponentText)
	digits := strings.TrimRight(strings.Replace(mantissa, ".", "", 1), "0")
	return sign + layout(digits, exponent+1), nil
}

// layout writes 0.<digits> × 10^n as ECMAScript does.
func layout(digits string, n int) string {
	k := len(digits)
	switch {
	case k <= n && n <= 21:
		return digits + strings.Repeat("0", n-k)
	case 0 < n && n <= 21:
		return digits[:n] + "." + digits[n:]
	case -6 < n && n <= 0:
		return "0." + strings.Repeat("0", -n) + digits
	}
	e := n - 1
	mantissa := digits[:1]
	if k > 1 {
		mantissa += "." + digits[1:]
	}
	sign := "+"
	if e < 0 {
		sign = "-"
		e = -e
	}
	return mantissa + "e" + sign + strconv.Itoa(e)
}

func sortedKeys[V any](m map[string]V) []string {
	keys := make([]string, 0, len(m))
	for key := range m {
		keys = append(keys, key)
	}
	slices.Sort(keys)
	return keys
}
