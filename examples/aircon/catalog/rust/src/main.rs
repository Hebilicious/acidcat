//! The air-conditioner catalog of `aircon.pkl`, written with the Rust catalog library. Run it with `cargo run` to
//! write the catalog.

use acid_cat_catalog::{Capability, Catalog, Schema, Target};
use serde_json::json;

fn aircon_catalog() -> Catalog {
    let mut catalog = Catalog::new(
        Some("Living-room air conditioner"),
        Some("Control and monitor one split-unit air conditioner on the home network."),
    );

    catalog
        .target(
            "app",
            Target {
                description: Some("The phone, desktop and web apps that people use.".into()),
                bindings: strings(&["typescript", "acme:swift", "kotlin"]),
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
                bindings: strings(&["http"]),
                ..Target::default()
            },
        )
        .target(
            "phone",
            Target {
                description: Some("Agents on an Android phone, through app functions.".into()),
                bindings: strings(&["appfunctions"]),
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
    let day = catalog.r#type(
        "Day",
        json!({ "enum": ["mon", "tue", "wed", "thu", "fri", "sat", "sun"] }),
    );
    let hour = json!({ "type": "integer", "minimum": 0, "maximum": 23 });
    let schedule = catalog.r#type(
        "Schedule",
        json!({
            "type": "object",
            "required": ["days", "hours"],
            "properties": {
                "days": { "type": "array", "items": day },
                "hours": { "type": "array", "items": hour }
            }
        }),
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

    let everywhere = strings(&["app", "taskbar", "cli", "mcp", "api", "phone"]);
    let controls = strings(&["app", "cli", "mcp", "api", "phone"]);
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
            audience: controls.clone(),
            input: Some(setting("speed", fan_speed)),
            failures: offline_only(),
            ..Capability::default()
        })
        .capability("aircon.schedule.set", Capability {
            description: "Turn the unit on at each given hour, on each given day. The default hour is 7.".into(),
            audience: controls,
            input: Some(json!({
                "type": "object",
                "required": ["days"],
                "properties": {
                    "days": { "type": "array", "items": day },
                    "hours": { "type": "array", "items": hour }
                }
            })),
            output: Some(schedule),
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

fn main() {
    match aircon_catalog().render() {
        Ok(text) => print!("{text}"),
        Err(problems) => panic!("the catalog does not conform: {problems:?}"),
    }
}
