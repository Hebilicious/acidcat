use std::path::{Path, PathBuf};
use std::process::Command;
use std::sync::OnceLock;

/// The path of the example `fixture`, built for the profile of the tests. Cargo builds the examples before the
/// integration tests only when it runs every target, so `cargo test --test conform` alone can find an old fixture,
/// or none. The first call builds it.
pub fn fixture() -> PathBuf {
    static FIXTURE: OnceLock<PathBuf> = OnceLock::new();
    FIXTURE.get_or_init(build).clone()
}

fn build() -> PathBuf {
    let tests = std::env::current_exe().expect("the path of the test program");
    let profile_directory = tests
        .parent()
        .and_then(Path::parent)
        .expect("the directory of the profile");
    let target = profile_directory.parent().expect("the target directory");
    let profile = match profile_directory.file_name().and_then(|name| name.to_str()) {
        Some("debug") => "dev",
        Some(name) => name,
        None => panic!("the directory of the profile has no name"),
    };
    let status = Command::new(env!("CARGO"))
        .args([
            "build",
            "--quiet",
            "--example",
            "fixture",
            "--profile",
            profile,
            "--target-dir",
        ])
        .arg(target)
        .current_dir(env!("CARGO_MANIFEST_DIR"))
        .status()
        .expect("cargo runs");
    assert!(status.success(), "cargo builds the fixture");
    profile_directory.join("examples").join(if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    })
}
