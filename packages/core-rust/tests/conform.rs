//! The Rust core passes `acid-cat conform` through each binding: MCP over HTTP (with the handshake, poll and webhook
//! delivery), MCP over stdio, HTTP, and the command line, in the same process and for a server. Each test serves the
//! conformance fixture (`examples/fixture.rs`), and runs `acid-cat conform` of the workspace with `pnpm exec`.

use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};

/// The settings of the fixture that the tests give to conform: the poll settings and the webhook limits.
const POLL: [&str; 4] = ["--poll-buffer", "5", "--poll-lease-ms", "2000"];
const WEBHOOK_LIMITS: [&str; 6] = [
    "--webhook-min-ttl-ms",
    "1000",
    "--webhook-max-ttl-ms",
    "5000",
    "--webhook-max-subscriptions",
    "3",
];

/// The root of the repository, where `pnpm exec acid-cat` runs.
fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
}

/// The fixture program. Cargo builds the examples before the integration tests, beside the directory of the tests.
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

/// A fixture server, stopped when it is dropped.
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

/// Run `acid-cat conform`, and check its report: no failure, no warning, and at least `minimum` checks, so that a
/// binding cannot pass by running no checks.
fn assert_conforms(args: &[&str], minimum: usize) {
    let output = Command::new("pnpm")
        .args(["exec", "acid-cat", "conform"])
        .args(args)
        .current_dir(repository())
        .output()
        .expect("pnpm runs acid-cat conform");
    let report = String::from_utf8_lossy(&output.stdout);
    let problems: Vec<&str> = report
        .lines()
        .filter(|line| line.starts_with('✗') || line.starts_with('!'))
        .collect();
    let passed = report.lines().filter(|line| line.starts_with('✓')).count();
    assert!(
        problems.is_empty(),
        "conform reports problems:\n{report}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        output.status.success(),
        "conform failed:\n{report}\n{}",
        String::from_utf8_lossy(&output.stderr)
    );
    assert!(
        passed >= minimum,
        "{passed} checks passed, expected {minimum} or more:\n{report}"
    );
}

/// A self-signed certificate for `localhost` and `127.0.0.1`, made by `openssl` in a temporary directory. The
/// receiver of conform uses it, and the fixture trusts it.
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
    let mut args = vec!["--mcp", &mcp, "--mcp-handshake"];
    args.extend(POLL);
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
    args.extend(WEBHOOK_LIMITS);
    assert_conforms(&args, 60);
}

#[test]
fn through_mcp_over_stdio() {
    let command = format!("{} mcp-stdio", fixture().display());
    let mut args = vec!["--mcp-stdio", &command];
    args.extend(POLL);
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
        .args(["exec", "acid-cat", "check"])
        .arg(&file)
        .current_dir(repository())
        .output()
        .expect("pnpm runs acid-cat check");
    let _ = std::fs::remove_file(&file);
    assert!(
        check.status.success(),
        "acid-cat check: {}{}",
        String::from_utf8_lossy(&check.stdout),
        String::from_utf8_lossy(&check.stderr)
    );
    assert!(
        !String::from_utf8_lossy(&check.stdout).contains("warning"),
        "acid-cat check warns: {}",
        String::from_utf8_lossy(&check.stdout)
    );
}
