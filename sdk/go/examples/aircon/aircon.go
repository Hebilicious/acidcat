// Package aircon writes the air-conditioner catalog (examples/aircon.pkl) with the Go SDK.
package aircon

import acidcat "acidcat.dev/sdk/go"

type schema = acidcat.Schema

// Catalog returns the air-conditioner catalog.
func Catalog() *acidcat.Catalog {
	catalog := acidcat.New(
		"Living-room air conditioner",
		"Control and monitor one split-unit air conditioner on the home network.",
	)

	catalog.
		Target("app", acidcat.Target{
			Description: "The phone, desktop and web apps that people use.",
			Bindings:    []string{"typescript", "acme:swift", "acme:kotlin"},
		}).
		Target("taskbar", acidcat.Target{
			Description: "A desktop taskbar widget showing the status and a power toggle.",
			Bindings:    []string{"typescript"},
		}).
		Target("cli", acidcat.Target{Bindings: []string{"cli"}}).
		Target("mcp", acidcat.Target{Description: "Agents, through an MCP server.", Bindings: []string{"mcp"}}).
		Target("api", acidcat.Target{Description: "Home-automation systems and scripts.", Bindings: []string{"http", "graphql"}})

	mode := catalog.Type("Mode", schema{"enum": []any{"cool", "heat", "dry", "fan", "auto"}})
	fanSpeed := catalog.Type("FanSpeed", schema{"enum": []any{"auto", "low", "medium", "high"}})
	status := catalog.Type("Status", schema{
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
	offline := catalog.Type("Offline", schema{
		"type":       "object",
		"properties": schema{"since": schema{"type": "string", "format": "date-time"}},
	})

	everywhere := []string{"app", "taskbar", "cli", "mcp", "api"}
	controls := []string{"app", "cli", "mcp", "api"}
	setting := func(name string, property schema) schema {
		return schema{"type": "object", "required": []any{name}, "properties": schema{name: property}}
	}
	offlineOnly := map[string]schema{"Offline": offline}

	return catalog.
		Capability("aircon.status.get", acidcat.Capability{
			Description: "Read the unit's power, mode, fan speed, target temperature and room temperature.",
			Audience:    everywhere,
			Output:      status,
			Failures:    offlineOnly,
			ReadOnly:    true,
			State:       status,
		}).
		Capability("aircon.power.set", acidcat.Capability{
			Description: "Turn the unit on or off.",
			Audience:    everywhere,
			Input:       setting("on", schema{"type": "boolean"}),
			Failures:    offlineOnly,
		}).
		Capability("aircon.mode.set", acidcat.Capability{
			Description: "Choose how the unit runs.",
			Audience:    controls,
			Input:       setting("mode", mode),
			Failures: map[string]schema{
				"Offline":    offline,
				"PoweredOff": {"type": "object", "description": "The unit must be on before its mode can change."},
			},
		}).
		Capability("aircon.temperature.set", acidcat.Capability{
			Description: "Set the target temperature in degrees Celsius.",
			Audience:    controls,
			Input:       setting("celsius", schema{"type": "number", "minimum": 16, "maximum": 31}),
			Failures:    offlineOnly,
		}).
		Capability("aircon.fan.set", acidcat.Capability{
			Description: "Set the fan speed.",
			Audience:    controls,
			Input:       setting("speed", fanSpeed),
			Failures:    offlineOnly,
		}).
		Capability("aircon.firmware.update", acidcat.Capability{
			Description: "Install the latest firmware. The unit restarts and is offline for about a minute.",
			Audience:    []string{"app"},
			Failures: map[string]schema{
				"Offline":  offline,
				"UpToDate": {"type": "object", "properties": schema{"version": schema{"type": "string"}}},
			},
		})
}
