// Package acidcat writes an AcidCat catalog in Go, and renders it to the JSON document the toolchain checks.
//
// This is an authoring library, not a runtime: a program uses it to produce acidcat.catalog.json, and nothing
// reads the catalog through it at runtime. See spec/catalog.md.
package acidcat

import (
	"bytes"
	"encoding/json"
	"errors"
	"fmt"
	"regexp"
	"strings"
)

// Schema is a JSON Schema 2020-12 schema, written as a plain map.
type Schema = map[string]any

// Target says how a target is served.
type Target struct {
	// Bindings serve the target, such as "typescript" and "webmcp".
	Bindings    []string
	Description string
	// Options are settings for the bindings, in a form each binding defines.
	Options Schema
}

// Capability describes one capability.
type Capability struct {
	// Description says what the capability does for its caller, written for people and agents.
	Description string
	// Audience lists the targets the capability is offered to. Empty means no target.
	Audience []string
	// Input must describe an object. Nil means an empty object.
	Input Schema
	// Output describes a successful call's value. Nil means null.
	Output Schema
	// Failures are keyed by tag.
	Failures map[string]Schema
	// ReadOnly is true when a call changes nothing anyone can observe. A hint for clients.
	ReadOnly bool
	// State describes a value that clients can observe.
	State Schema
}

var (
	idPattern        = regexp.MustCompile(`^[a-z][a-z0-9]*(-[a-z0-9]+)*(\.[a-z][a-z0-9]*(-[a-z0-9]+)*)+$`)
	namePattern      = regexp.MustCompile(`^[a-z][a-z0-9-]*(:[a-z][a-z0-9-]*)?$`)
	typeNamePattern  = regexp.MustCompile(`^[A-Za-z][A-Za-z0-9_]*$`)
	referencePattern = regexp.MustCompile(`^#/\$defs/([A-Za-z][A-Za-z0-9_]*)$`)
)

type named[T any] struct {
	name  string
	value T
}

// Catalog is a catalog being written.
type Catalog struct {
	title        string
	description  string
	targets      []named[Target]
	types        []named[Schema]
	capabilities []named[Capability]
	duplicates   []string
}

// New starts a catalog.
func New(title, description string) *Catalog {
	return &Catalog{title: title, description: description}
}

// Target declares a target.
func (c *Catalog) Target(name string, target Target) *Catalog {
	if c.target(name) != nil {
		c.duplicates = append(c.duplicates, fmt.Sprintf("the target %s is declared twice", name))
	}
	c.targets = append(c.targets, named[Target]{name, target})
	return c
}

// Type declares a shared type, and returns the schema that references it.
func (c *Catalog) Type(name string, schema Schema) Schema {
	if c.typeNamed(name) != nil {
		c.duplicates = append(c.duplicates, fmt.Sprintf("the type %s is declared twice", name))
	}
	c.types = append(c.types, named[Schema]{name, schema})
	return Schema{"$ref": "#/$defs/" + name}
}

// Capability declares a capability.
func (c *Catalog) Capability(id string, capability Capability) *Catalog {
	for _, existing := range c.capabilities {
		if existing.name == id {
			c.duplicates = append(c.duplicates, fmt.Sprintf("the capability %s is declared twice", id))
		}
	}
	c.capabilities = append(c.capabilities, named[Capability]{id, capability})
	return c
}

// Validate returns the catalog rules this catalog breaks. It is empty when the catalog conforms.
func (c *Catalog) Validate() []string {
	problems := append([]string{}, c.duplicates...)
	for _, t := range c.targets {
		if !namePattern.MatchString(t.name) {
			problems = append(problems, fmt.Sprintf("the target name %s is malformed", t.name))
		}
		if len(t.value.Bindings) == 0 {
			problems = append(problems, fmt.Sprintf("the target %s has no bindings", t.name))
		}
		if hasRepeat(t.value.Bindings) {
			problems = append(problems, fmt.Sprintf("the target %s repeats a binding", t.name))
		}
		for _, binding := range t.value.Bindings {
			if !namePattern.MatchString(binding) {
				problems = append(problems, fmt.Sprintf("the target %s names the malformed binding %s", t.name, binding))
			}
		}
	}
	for _, t := range c.types {
		if !typeNamePattern.MatchString(t.name) {
			problems = append(problems, fmt.Sprintf("the type name %s is malformed", t.name))
		}
		for _, problem := range c.referenceProblems(t.value) {
			problems = append(problems, fmt.Sprintf("the type %s %s", t.name, problem))
		}
	}
	for _, entry := range c.capabilities {
		id, capability := entry.name, entry.value
		if len(id) > 128 || !idPattern.MatchString(id) {
			problems = append(problems, fmt.Sprintf("the id %s is malformed", id))
		}
		if strings.TrimSpace(capability.Description) == "" {
			problems = append(problems, fmt.Sprintf("%s has no description", id))
		}
		if hasRepeat(capability.Audience) {
			problems = append(problems, fmt.Sprintf("%s repeats a target in its audience", id))
		}
		for _, target := range capability.Audience {
			if c.target(target) == nil {
				problems = append(problems, fmt.Sprintf("%s names the undeclared target %s", id, target))
			}
		}
		if capability.Input != nil && c.resolve(capability.Input)["type"] != "object" {
			problems = append(problems, fmt.Sprintf("%s input does not describe an object", id))
		}
		schemas := []Schema{capability.Input, capability.Output, capability.State}
		for _, tag := range sortedKeys(capability.Failures) {
			schemas = append(schemas, capability.Failures[tag])
		}
		for _, schema := range schemas {
			if schema == nil {
				continue
			}
			for _, problem := range c.referenceProblems(schema) {
				problems = append(problems, fmt.Sprintf("%s %s", id, problem))
			}
		}
	}
	return problems
}

// Render returns the catalog as JSON text, ready to write to acidcat.catalog.json. It fails when the catalog
// breaks a rule.
func (c *Catalog) Render() ([]byte, error) {
	if problems := c.Validate(); len(problems) > 0 {
		return nil, errors.New("the catalog does not conform:\n" + strings.Join(problems, "\n"))
	}
	document := object{{"acidcat", "0.1"}}
	document = document.optional("title", c.title, c.title != "")
	document = document.optional("description", c.description, c.description != "")

	targets := object{}
	for _, t := range c.targets {
		target := object{{"bindings", t.value.Bindings}}
		target = target.optional("description", t.value.Description, t.value.Description != "")
		target = target.optional("options", t.value.Options, t.value.Options != nil)
		targets = append(targets, member{t.name, target})
	}
	document = append(document, member{"targets", targets})

	if len(c.types) > 0 {
		types := object{}
		for _, t := range c.types {
			types = append(types, member{t.name, t.value})
		}
		document = append(document, member{"$defs", types})
	}

	capabilities := object{}
	for _, entry := range c.capabilities {
		capability := entry.value
		audience := capability.Audience
		if audience == nil {
			audience = []string{}
		}
		out := object{{"description", capability.Description}, {"audience", audience}}
		out = out.optional("input", capability.Input, capability.Input != nil)
		out = out.optional("output", capability.Output, capability.Output != nil)
		out = out.optional("failures", capability.Failures, len(capability.Failures) > 0)
		out = out.optional("readOnly", true, capability.ReadOnly)
		out = out.optional("state", capability.State, capability.State != nil)
		capabilities = append(capabilities, member{entry.name, out})
	}
	document = append(document, member{"capabilities", capabilities})

	var buffer bytes.Buffer
	encoder := json.NewEncoder(&buffer)
	encoder.SetEscapeHTML(false)
	encoder.SetIndent("", "  ")
	if err := encoder.Encode(document); err != nil {
		return nil, err
	}
	return buffer.Bytes(), nil
}

func (c *Catalog) target(name string) *Target {
	for i := range c.targets {
		if c.targets[i].name == name {
			return &c.targets[i].value
		}
	}
	return nil
}

func (c *Catalog) typeNamed(name string) Schema {
	for _, t := range c.types {
		if t.name == name {
			return t.value
		}
	}
	return nil
}

func (c *Catalog) resolve(schema Schema) Schema {
	if reference, ok := schema["$ref"].(string); ok {
		if match := referencePattern.FindStringSubmatch(reference); match != nil {
			if t := c.typeNamed(match[1]); t != nil {
				return t
			}
		}
	}
	return schema
}

func (c *Catalog) referenceProblems(schema any) []string {
	var problems []string
	visit(schema, func(node map[string]any) {
		if _, ok := node["$defs"]; ok {
			problems = append(problems, "carries its own $defs; declare shared types with Type")
		}
		reference, ok := node["$ref"]
		if !ok {
			return
		}
		text, _ := reference.(string)
		match := referencePattern.FindStringSubmatch(text)
		if match == nil || c.typeNamed(match[1]) == nil {
			problems = append(problems, fmt.Sprintf("references %v, which is not a type", reference))
		}
	})
	return problems
}

func visit(value any, onObject func(map[string]any)) {
	switch v := value.(type) {
	case map[string]any:
		onObject(v)
		for _, key := range sortedKeys(v) {
			visit(v[key], onObject)
		}
	case []any:
		for _, item := range v {
			visit(item, onObject)
		}
	case []string, string, bool, nil, float64, int:
	}
}

func hasRepeat(values []string) bool {
	seen := map[string]bool{}
	for _, value := range values {
		if seen[value] {
			return true
		}
		seen[value] = true
	}
	return false
}
