//! A music-player catalog, written with the Rust catalog library.
//!
//! Run it with `cargo run --example player` to print the catalog.

use acid_cat_catalog::{Capability, Catalog, Target};
use serde_json::json;

pub fn player_catalog() -> Catalog {
    let mut catalog = Catalog::new(
        Some("Music player"),
        Some("Play, pause and queue the music of one home speaker."),
    );

    catalog
        .target(
            "desktop",
            Target {
                description: Some("The desktop app, with a mini player in the menu bar.".into()),
                bindings: strings(&["typescript"]),
                ..Target::default()
            },
        )
        .target(
            "remote",
            Target {
                description: Some("Shell scripts and keyboard shortcuts.".into()),
                bindings: strings(&["cli"]),
                options: Some(json!({ "aliases": { "next": "skip" } })),
            },
        )
        .target(
            "assistant",
            Target {
                description: Some("Assistants, through an MCP server.".into()),
                bindings: strings(&["mcp"]),
                ..Target::default()
            },
        );

    let track = catalog.r#type(
        "Track",
        json!({
            "type": "object",
            "required": ["id", "title", "artist", "seconds"],
            "properties": {
                "id": { "type": "string" },
                "title": { "type": "string" },
                "artist": { "type": "string" },
                "seconds": { "type": "integer", "minimum": 0 }
            }
        }),
    );
    let playback = catalog.r#type(
        "Playback",
        json!({
            "type": "object",
            "required": ["playing", "volume", "queue"],
            "properties": {
                "playing": { "type": "boolean" },
                "track": track,
                "positionSeconds": { "type": "number" },
                "volume": { "type": "integer", "minimum": 0, "maximum": 100 },
                "queue": { "type": "array", "items": track }
            }
        }),
    );
    let unknown_track = catalog.r#type(
        "UnknownTrack",
        json!({
            "type": "object",
            "required": ["id"],
            "properties": { "id": { "type": "string" } }
        }),
    );

    let everyone = strings(&["desktop", "remote", "assistant"]);

    catalog
        .capability("player.playback.get", Capability {
            description: "Read the track that plays, its position, the volume and the queue.".into(),
            audience: everyone.clone(),
            output: Some(playback.clone()),
            read_only: true,
            state: Some(playback.clone()),
            ..Capability::default()
        })
        .capability("player.track.play", Capability {
            description: "Play a track now, or add it to the queue.".into(),
            audience: everyone.clone(),
            input: Some(json!({
                "type": "object",
                "required": ["id"],
                "properties": {
                    "id": { "type": "string" },
                    "queue": { "enum": ["now", "next", "last"], "default": "now" },
                    "startSeconds": { "type": "number", "minimum": 0 },
                    "shuffle": { "type": "boolean" }
                }
            })),
            output: Some(playback),
            failures: vec![
                ("UnknownTrack".into(), unknown_track),
                ("Offline".into(), json!({
                    "type": "object",
                    "description": "The speaker does not answer on the home network."
                })),
            ],
            ..Capability::default()
        })
        .capability("player.volume.set", Capability {
            description: "Set the volume, from 0 to 100.".into(),
            audience: strings(&["desktop", "remote"]),
            input: Some(json!({
                "type": "object",
                "required": ["level"],
                "properties": { "level": { "type": "integer", "minimum": 0, "maximum": 100 } }
            })),
            ..Capability::default()
        });
    catalog
}

fn strings(values: &[&str]) -> Vec<String> {
    values.iter().map(|value| (*value).to_owned()).collect()
}

#[allow(dead_code)]
fn main() {
    match player_catalog().render() {
        Ok(text) => print!("{text}"),
        Err(problems) => panic!("the catalog does not conform: {problems:?}"),
    }
}
