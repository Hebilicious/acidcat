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
    let mut cargo = Command::new(env!("CARGO"));
    // Cargo gives the test program the variables of its package, and the build script of ring reruns when one of them
    // changes, so the next `cargo test` builds ring again.
    for (name, _) in std::env::vars_os() {
        if name.to_str().is_some_and(is_variable_of_the_package) {
            cargo.env_remove(name);
        }
    }
    let output = cargo
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

fn is_variable_of_the_package(name: &str) -> bool {
    [
        "CARGO_PKG_",
        "CARGO_MANIFEST_",
        "CARGO_CRATE_",
        "CARGO_BIN_",
        "CARGO_PRIMARY_PACKAGE",
        "CARGO_TARGET_TMPDIR",
        "CARGO_RUSTC_CURRENT_DIR",
        "OUT_DIR",
    ]
    .iter()
    .any(|prefix| name.starts_with(prefix))
}
