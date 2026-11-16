use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

mod fixture_settings;

use fixture_settings::{
    POLL_BUFFER, POLL_LEASE_MS, WEBHOOK_MAX_SUBSCRIPTIONS, WEBHOOK_MAX_TTL_MS, WEBHOOK_MIN_TTL_MS,
};

fn poll_flags() -> Vec<String> {
    vec![
        "--poll-buffer".into(),
        POLL_BUFFER.to_string(),
        "--poll-lease-ms".into(),
        POLL_LEASE_MS.to_string(),
    ]
}

fn webhook_limit_flags() -> Vec<String> {
    vec![
        "--webhook-min-ttl-ms".into(),
        WEBHOOK_MIN_TTL_MS.to_string(),
        "--webhook-max-ttl-ms".into(),
        WEBHOOK_MAX_TTL_MS.to_string(),
        "--webhook-max-subscriptions".into(),
        WEBHOOK_MAX_SUBSCRIPTIONS.to_string(),
    ]
}

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// Cargo builds the examples before the integration tests, beside the directory of the tests.
fn fixture() -> PathBuf {
    let tests = std::env::current_exe().expect("the path of the test program");
    let target = tests
        .parent()
        .and_then(Path::parent)
        .expect("the target directory");
    target.join("examples").join(if cfg!(windows) {
        "fixture.exe"
    } else {
        "fixture"
    })
}

struct Server {
    child: Child,
    url: String,
}

impl Server {
    fn start(args: &[&str]) -> Server {
        let mut child = Command::new(fixture())
            .arg("serve")
            .args(args)
            .stdout(Stdio::piped())
            .spawn()
            .expect("the fixture starts");
        let mut line = String::new();
        BufReader::new(child.stdout.take().expect("the output of the fixture"))
            .read_line(&mut line)
            .expect("the fixture writes its URL");
        Server {
            child,
            url: line.trim().to_owned(),
        }
    }
}

impl Drop for Server {
    fn drop(&mut self) {
        let _ = self.child.kill();
        let _ = self.child.wait();
    }
}

fn assert_conforms(args: &[&str], minimum: usize) {
    let output = Command::new("pnpm")
        .args(["exec", "acid-cat", "conform", "--output", "json"])
        .args(args)
        .current_dir(repository())
        .output()
        .expect("pnpm runs acid-cat conform");
    let report: serde_json::Value =
        serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
            panic!(
                "conform writes no JSON report ({error}):\n{}\n{}",
                String::from_utf8_lossy(&output.stdout),
                String::from_utf8_lossy(&output.stderr)
            )
        });
    let problems: Vec<&serde_json::Value> = report["checks"]
        .as_array()
        .expect("the report has checks")
        .iter()
        .filter(|check| check["passed"] == false || check["warning"] == true)
        .collect();
    assert!(
        problems.is_empty(),
        "conform reports problems: {problems:#?}"
    );
    assert!(
        output.status.success(),
        "conform failed:\n{report:#}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    let passed = report["passed"]
        .as_u64()
        .expect("the report counts the checks that pass");
    assert!(
        passed >= minimum as u64,
        "{passed} checks passed, expected {minimum} or more"
    );
}

struct Certificate {
    directory: PathBuf,
}

impl Certificate {
    fn new() -> Certificate {
        let directory =
            std::env::temp_dir().join(format!("acid-cat-core-rust-{}", std::process::id()));
        std::fs::create_dir_all(&directory).expect("the directory of the certificate");
        let status = Command::new("openssl")
            .args([
                "req",
                "-x509",
                "-newkey",
                "ec",
                "-pkeyopt",
                "ec_paramgen_curve:prime256v1",
                "-nodes",
                "-days",
                "1",
                "-subj",
                "/CN=localhost",
            ])
            .args([
                "-addext",
                "subjectAltName=DNS:localhost,IP:127.0.0.1",
                "-keyout",
            ])
            .arg(directory.join("key.pem"))
            .arg("-out")
            .arg(directory.join("cert.pem"))
            .stdout(Stdio::null())
            .stderr(Stdio::null())
            .status()
            .expect("openssl runs");
        assert!(status.success(), "openssl makes the certificate");
        Certificate { directory }
    }

    fn file(&self, name: &str) -> String {
        self.directory.join(name).to_string_lossy().into_owned()
    }
}

impl Drop for Certificate {
    fn drop(&mut self) {
        let _ = std::fs::remove_dir_all(&self.directory);
    }
}

#[test]
fn through_mcp_over_http_with_the_handshake_poll_and_webhook_delivery() {
    let certificate = Certificate::new();
    let (cert, key) = (certificate.file("cert.pem"), certificate.file("key.pem"));
    let server = Server::start(&["--webhook-ca", &cert]);
    let mcp = format!("{}/mcp", server.url);
    let (poll, webhook_limits) = (poll_flags(), webhook_limit_flags());
    let mut args = vec!["--mcp", &mcp, "--mcp-handshake"];
    args.extend(poll.iter().map(String::as_str));
    args.extend([
        "--webhook-principal",
        "conform",
        "--webhook-other-principal",
        "conform-other",
        "--webhook-cert",
        &cert,
        "--webhook-key",
        &key,
    ]);
    args.extend(webhook_limits.iter().map(String::as_str));
    assert_conforms(&args, 60);
}

#[test]
fn through_mcp_over_stdio() {
    let command = format!("{} mcp-stdio", fixture().display());
    let poll = poll_flags();
    let mut args = vec!["--mcp-stdio", &command];
    args.extend(poll.iter().map(String::as_str));
    assert_conforms(&args, 50);
}

#[test]
fn through_http() {
    let server = Server::start(&[]);
    assert_conforms(&["--http", &format!("{}/api", server.url)], 20);
}

#[test]
fn through_the_command_line() {
    let command = format!("{} cli", fixture().display());
    assert_conforms(&["--cli", &command], 20);
}

#[test]
fn through_the_command_line_that_calls_a_server() {
    let server = Server::start(&[]);
    let command = format!("{} cli-remote {}/cli", fixture().display(), server.url);
    assert_conforms(&["--cli", &command], 20);
}

#[test]
fn the_fixture_writes_a_catalog_that_conforms() {
    let output = Command::new(fixture())
        .arg("catalog")
        .output()
        .expect("the fixture writes its catalog");
    let file = std::env::temp_dir().join(format!(
        "acid-cat-core-rust-fixture-{}.acidcat.json",
        std::process::id()
    ));
    std::fs::write(&file, &output.stdout).expect("the catalog is written");
    let check = Command::new("pnpm")
        .args(["exec", "acid-cat", "check", "--strict", "--output", "json"])
        .arg(&file)
        .current_dir(repository())
        .output()
        .expect("pnpm runs acid-cat check");
    let _ = std::fs::remove_file(&file);
    let report: serde_json::Value =
        serde_json::from_slice(&check.stdout).expect("acid-cat check writes a JSON report");
    assert!(check.status.success(), "acid-cat check: {report:#}");
    assert_eq!(report["conforms"], true, "acid-cat check: {report:#}");
}
