// Package garage writes a garage-door catalog with the Go catalog library.
package garage

import "github.com/Hebilicious/acidcat/packages/catalog/go"

type schema = catalog.Schema

// Catalog returns the garage-door catalog.
func Catalog() *catalog.Catalog {
	c := catalog.New(
		"Garage door",
		"Open, close and watch one motorised garage door.",
	)

	c.
		Target("phone", catalog.Target{
			Description: "The phone app of the people who live in the house.",
			Bindings:    []string{"typescript", "acme:swift"},
		}).
		Target("keypad", catalog.Target{
			Description: "The keypad on the outside wall.",
			Bindings:    []string{"acme:keypad"},
			Options:     schema{"digits": 6, "backlight": true},
		}).
		Target("assistant", catalog.Target{Description: "A voice assistant, through an MCP server.", Bindings: []string{"mcp"}})

	position := c.Type("Position", schema{"enum": []any{"open", "closed", "opening", "closing", "stopped"}})
	door := c.Type("Door", schema{
		"type":     "object",
		"required": []any{"position", "light"},
		"properties": schema{
			"position":  position,
			"light":     schema{"type": "boolean"},
			"openSince": schema{"type": "string", "format": "date-time"},
		},
	})
	obstructed := c.Type("Obstructed", schema{
		"type":        "object",
		"description": "The light beam at the bottom of the door is broken.",
		"properties":  schema{"since": schema{"type": "string", "format": "date-time"}},
	})

	return c.
		Capability("garage.door.get", catalog.Capability{
			Description: "Read the position of the door and the state of its light.",
			Audience:    []string{"phone", "keypad", "assistant"},
			Output:      door,
			ReadOnly:    true,
			State:       door,
		}).
		Capability("garage.door.open", catalog.Capability{
			Description: "Open the door, and close it again after a number of minutes.",
			Audience:    []string{"phone", "keypad", "assistant"},
			Input: schema{
				"type": "object",
				"properties": schema{
					"closeAfterMinutes": schema{"type": "integer", "minimum": 1, "maximum": 120},
					"light":             schema{"type": "boolean", "default": true},
					"reason":            schema{"type": "string", "maxLength": 80},
				},
			},
			Output: door,
			Failures: map[string]schema{
				"Obstructed": obstructed,
				"Jammed":     {"type": "object", "required": []any{"motorAmps"}, "properties": schema{"motorAmps": schema{"type": "number"}}},
			},
		}).
		Capability("garage.door.close", catalog.Capability{
			Description: "Close the door.",
			Audience:    []string{"phone", "keypad", "assistant"},
			Output:      door,
			Failures:    map[string]schema{"Obstructed": obstructed},
		}).
		Capability("garage.code.set", catalog.Capability{
			Description: "Set the code that opens the door from the keypad.",
			Audience:    []string{"phone"},
			Input: schema{
				"type":     "object",
				"required": []any{"code"},
				"properties": schema{
					"code":    schema{"type": "string", "pattern": "^[0-9]{6}$"},
					"expires": schema{"type": "string", "format": "date-time"},
				},
			},
			Failures: map[string]schema{
				"TooSimple": {"type": "object", "description": "The code repeats one digit or counts up or down."},
			},
		})
}
