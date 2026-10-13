//! The air-conditioner catalog (examples/aircon.pkl), written with the Rust catalog library.
//!
//! Run it with `cargo run --example aircon` to print the catalog.

use acid_cat_catalog::{Capability, Catalog, Schema, Target};
use serde_json::json;

pub fn aircon_catalog() -> Catalog {
    let mut catalog = Catalog::new(
        Some("Living-room air conditioner"),
        Some("Control and monitor one split-unit air conditioner on the home network."),
    );

    catalog
        .target(
            "app",
            Target {
                description: Some("The phone, desktop and web apps that people use.".into()),
                bindings: strings(&["typescript", "acme:swift", "acme:kotlin"]),
                ..Target::default()
            },
        )
        .target(
            "taskbar",
            Target {
                description: Some(
                    "A desktop taskbar widget showing the status and a power toggle.".into(),
                ),
                bindings: strings(&["typescript"]),
                ..Target::default()
            },
        )
        .target(
            "cli",
            Target {
                bindings: strings(&["cli"]),
                ..Target::default()
            },
        )
        .target(
            "mcp",
            Target {
                description: Some("Agents, through an MCP server.".into()),
                bindings: strings(&["mcp"]),
                ..Target::default()
            },
        )
        .target(
            "api",
            Target {
                description: Some("Home-automation systems and scripts.".into()),
                bindings: strings(&["http", "graphql"]),
                ..Target::default()
            },
        );

    let mode = catalog.r#type(
        "Mode",
        json!({ "enum": ["cool", "heat", "dry", "fan", "auto"] }),
    );
    let fan_speed = catalog.r#type(
        "FanSpeed",
        json!({ "enum": ["auto", "low", "medium", "high"] }),
    );
    let status = catalog.r#type(
        "Status",
        json!({
            "type": "object",
            "required": ["power", "mode", "fan", "targetCelsius", "roomCelsius"],
            "properties": {
                "power": { "type": "boolean" },
                "mode": mode,
                "fan": fan_speed,
                "targetCelsius": { "type": "number" },
                "roomCelsius": { "type": "number" }
            }
        }),
    );
    let offline = catalog.r#type(
        "Offline",
        json!({
            "type": "object",
            "properties": { "since": { "type": "string", "format": "date-time" } }
        }),
    );

    let everywhere = strings(&["app", "taskbar", "cli", "mcp", "api"]);
    let controls = strings(&["app", "cli", "mcp", "api"]);
    let setting = |name: &str, property: Schema| json!({ "type": "object", "required": [name], "properties": { name: property } });
    let offline_only = || vec![("Offline".to_owned(), offline.clone())];

    catalog
        .capability("aircon.status.get", Capability {
            description: "Read the unit's power, mode, fan speed, target temperature and room temperature.".into(),
            audience: everywhere.clone(),
            output: Some(status.clone()),
            failures: offline_only(),
            read_only: true,
            state: Some(status),
            ..Capability::default()
        })
        .capability("aircon.power.set", Capability {
            description: "Turn the unit on or off.".into(),
            audience: everywhere,
            input: Some(setting("on", json!({ "type": "boolean" }))),
            failures: offline_only(),
            ..Capability::default()
        })
        .capability("aircon.mode.set", Capability {
            description: "Choose how the unit runs.".into(),
            audience: controls.clone(),
            input: Some(setting("mode", mode)),
            failures: vec![
                ("Offline".into(), offline.clone()),
                ("PoweredOff".into(), json!({
                    "type": "object",
                    "description": "The unit must be on before its mode can change."
                })),
            ],
            ..Capability::default()
        })
        .capability("aircon.temperature.set", Capability {
            description: "Set the target temperature in degrees Celsius.".into(),
            audience: controls.clone(),
            input: Some(setting("celsius", json!({ "type": "number", "minimum": 16, "maximum": 31 }))),
            failures: offline_only(),
            ..Capability::default()
        })
        .capability("aircon.fan.set", Capability {
            description: "Set the fan speed.".into(),
            audience: controls,
            input: Some(setting("speed", fan_speed)),
            failures: offline_only(),
            ..Capability::default()
        })
        .capability("aircon.firmware.update", Capability {
            description: "Install the latest firmware. The unit restarts and is offline for about a minute.".into(),
            audience: strings(&["app"]),
            failures: vec![
                ("Offline".into(), offline.clone()),
                ("UpToDate".into(), json!({ "type": "object", "properties": { "version": { "type": "string" } } })),
            ],
            ..Capability::default()
        });
    catalog
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[allow(dead_code)]
fn main() {
    match aircon_catalog().render() {
        Ok(text) => print!("{text}"),
        Err(problems) => panic!("the catalog does not conform: {problems:?}"),
    }
}
