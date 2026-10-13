// Package aircon writes the air-conditioner catalog (examples/aircon.pkl) with the Go catalog library.
package aircon

import "acidcat.dev/catalog"

type schema = catalog.Schema

// Catalog returns the air-conditioner c.
func Catalog() *catalog.Catalog {
	c := catalog.New(
		"Living-room air conditioner",
		"Control and monitor one split-unit air conditioner on the home network.",
	)

	c.
		Target("app", catalog.Target{
			Description: "The phone, desktop and web apps that people use.",
			Bindings:    []string{"typescript", "acme:swift", "acme:kotlin"},
		}).
		Target("taskbar", catalog.Target{
			Description: "A desktop taskbar widget showing the status and a power toggle.",
			Bindings:    []string{"typescript"},
		}).
		Target("cli", catalog.Target{Bindings: []string{"cli"}}).
		Target("mcp", catalog.Target{Description: "Agents, through an MCP server.", Bindings: []string{"mcp"}}).
		Target("api", catalog.Target{Description: "Home-automation systems and scripts.", Bindings: []string{"http", "graphql"}})

	mode := c.Type("Mode", schema{"enum": []any{"cool", "heat", "dry", "fan", "auto"}})
	fanSpeed := c.Type("FanSpeed", schema{"enum": []any{"auto", "low", "medium", "high"}})
	status := c.Type("Status", schema{
		"type":     "object",
		"required": []any{"power", "mode", "fan", "targetCelsius", "roomCelsius"},
		"properties": schema{
			"power":         schema{"type": "boolean"},
			"mode":          mode,
			"fan":           fanSpeed,
			"targetCelsius": schema{"type": "number"},
			"roomCelsius":   schema{"type": "number"},
		},
	})
	offline := c.Type("Offline", schema{
		"type":       "object",
		"properties": schema{"since": schema{"type": "string", "format": "date-time"}},
	})

	everywhere := []string{"app", "taskbar", "cli", "mcp", "api"}
	controls := []string{"app", "cli", "mcp", "api"}
	setting := func(name string, property schema) schema {
		return schema{"type": "object", "required": []any{name}, "properties": schema{name: property}}
	}
	offlineOnly := map[string]schema{"Offline": offline}

	return c.
		Capability("aircon.status.get", catalog.Capability{
			Description: "Read the unit's power, mode, fan speed, target temperature and room temperature.",
			Audience:    everywhere,
			Output:      status,
			Failures:    offlineOnly,
			ReadOnly:    true,
			State:       status,
		}).
		Capability("aircon.power.set", catalog.Capability{
			Description: "Turn the unit on or off.",
			Audience:    everywhere,
			Input:       setting("on", schema{"type": "boolean"}),
			Failures:    offlineOnly,
		}).
		Capability("aircon.mode.set", catalog.Capability{
			Description: "Choose how the unit runs.",
			Audience:    controls,
			Input:       setting("mode", mode),
			Failures: map[string]schema{
				"Offline":    offline,
				"PoweredOff": {"type": "object", "description": "The unit must be on before its mode can change."},
			},
		}).
		Capability("aircon.temperature.set", catalog.Capability{
			Description: "Set the target temperature in degrees Celsius.",
			Audience:    controls,
			Input:       setting("celsius", schema{"type": "number", "minimum": 16, "maximum": 31}),
			Failures:    offlineOnly,
		}).
		Capability("aircon.fan.set", catalog.Capability{
			Description: "Set the fan speed.",
			Audience:    controls,
			Input:       setting("speed", fanSpeed),
			Failures:    offlineOnly,
		}).
		Capability("aircon.firmware.update", catalog.Capability{
			Description: "Install the latest firmware. The unit restarts and is offline for about a minute.",
			Audience:    []string{"app"},
			Failures: map[string]schema{
				"Offline":  offline,
				"UpToDate": {"type": "object", "properties": schema{"version": schema{"type": "string"}}},
			},
		})
}
