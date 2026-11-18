use std::path::PathBuf;
use std::process::{Command, Stdio};
use std::sync::OnceLock;

use serde_json::Value;

/// The path of the example `fixture`. Cargo builds the examples before the integration tests only when it runs every
/// target, so `cargo test --test conform` alone can find an old fixture, or none. The first call builds it. The path
/// comes from the messages of Cargo, because the layout of the target directory depends on the version of Cargo.
pub fn fixture() -> PathBuf {
    static FIXTURE: OnceLock<PathBuf> = OnceLock::new();
    FIXTURE.get_or_init(build).clone()
}

fn build() -> PathBuf {
    let output = Command::new(env!("CARGO"))
        .args([
            "build",
            "--quiet",
            "--example",
            "fixture",
            "--message-format=json-render-diagnostics",
        ])
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .stderr(Stdio::inherit())
        .output()
        .expect("cargo runs");
    assert!(output.status.success(), "cargo builds the fixture");
    String::from_utf8_lossy(&output.stdout)
        .lines()
        .filter_map(|line| serde_json::from_str::<Value>(line).ok())
        .filter(|message| message["target"]["name"] == "fixture")
        .find_map(|message| message["executable"].as_str().map(PathBuf::from))
        .expect("cargo names the executable of the fixture")
}
