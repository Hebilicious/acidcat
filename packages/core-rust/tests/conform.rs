use std::io::{BufRead, BufReader};
use std::path::{Path, PathBuf};
use std::process::{Child, Command, Stdio};
use std::time::{Duration, Instant};

mod fixture_program;
mod fixture_settings;

use acid_cat_core::cli::{INTERRUPT_GRACE, exit};
use serde_json::{Map, Value, json};

use fixture_program::fixture;
use fixture_settings::{POLL_BUFFER, POLL_LEASE_MS, WEBHOOK_MAX_SUBSCRIPTIONS, WEBHOOK_MIN_TTL_MS};

fn poll_flags() -> Vec<String> {
    vec!["--poll-buffer".into(), POLL_BUFFER.to_string()]
}

fn webhook_limit_flags() -> Vec<String> {
    vec![
        "--webhook-min-ttl-ms".into(),
        WEBHOOK_MIN_TTL_MS.to_string(),
        "--webhook-max-subscriptions".into(),
        WEBHOOK_MAX_SUBSCRIPTIONS.to_string(),
    ]
}

const DEADLINE: Duration = Duration::from_secs(10);

fn repository() -> PathBuf {
    Path::new(env!("CARGO_MANIFEST_DIR")).join("../..")
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
    let report: Value = serde_json::from_slice(&output.stdout).unwrap_or_else(|error| {
        panic!(
            "conform writes no JSON report ({error}):\n{}\n{}",
            String::from_utf8_lossy(&output.stdout),
            String::from_utf8_lossy(&output.stderr)
        )
    });
    let problems: Vec<&Value> = report["checks"]
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
    let mcp_lease = format!("{}/mcp-lease", server.url);
    let lease_ms = POLL_LEASE_MS.to_string();
    let (poll, webhook_limits) = (poll_flags(), webhook_limit_flags());
    let mut args = vec!["--mcp", &mcp, "--mcp-handshake"];
    args.extend(poll.iter().map(String::as_str));
    args.extend(["--poll-lease-mcp", &mcp_lease, "--poll-lease-ms", &lease_ms]);
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

#[cfg(unix)]
struct Interrupted {
    code: Option<i32>,
    stderr: String,
    after_interrupt: Duration,
}

#[cfg(unix)]
fn interrupted_blocking_call(interrupts: usize) -> Interrupted {
    let directory = std::env::temp_dir().join(format!(
        "acid-cat-core-rust-interrupt-{}-{interrupts}",
        std::process::id()
    ));
    std::fs::create_dir_all(&directory).expect("the directory is made");
    let marker = directory.join("held");
    let mut child = Command::new(fixture())
        .args(["cli-blocking", "fixture", "hold", "--key", "k", "--marker"])
        .arg(&marker)
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the fixture starts");
    let start = Instant::now();
    while !marker.exists() {
        assert!(
            start.elapsed() < DEADLINE,
            "the call did not write its marker file"
        );
        std::thread::sleep(Duration::from_millis(10));
    }
    let interrupt = || {
        Command::new("kill")
            .args(["-INT", &child.id().to_string()])
            .status()
            .expect("kill runs");
    };
    let mut interrupted = Instant::now();
    interrupt();
    if interrupts == 2 {
        // Unix merges a signal that is still pending with the next one of the same kind.
        let cancelled = directory.join("held.cancelled");
        while !cancelled.exists() {
            assert!(
                interrupted.elapsed() < DEADLINE,
                "the call did not write its marker file when it was cancelled"
            );
            std::thread::sleep(Duration::from_millis(10));
        }
        interrupted = Instant::now();
        interrupt();
    }
    let status = loop {
        if let Some(status) = child.try_wait().expect("the status of the fixture") {
            break Some(status);
        }
        if interrupted.elapsed() > DEADLINE {
            child.kill().expect("the fixture stops");
            break None;
        }
        std::thread::sleep(Duration::from_millis(5));
    };
    let elapsed = interrupted.elapsed();
    let mut stderr = String::new();
    if status.is_some() {
        std::io::Read::read_to_string(
            &mut child.stderr.take().expect("standard error"),
            &mut stderr,
        )
        .expect("standard error is text");
    }
    let _ = std::fs::remove_dir_all(&directory);
    Interrupted {
        code: status.and_then(|status| status.code()),
        stderr,
        after_interrupt: elapsed,
    }
}

#[cfg(unix)]
#[test]
fn a_call_that_blocks_exits_with_130_after_the_grace_period_or_at_once_after_a_second_interrupt() {
    let once = interrupted_blocking_call(1);
    assert_eq!(
        (once.code, once.stderr.as_str()),
        (Some(exit::CANCELLED), "")
    );
    assert!(
        once.after_interrupt >= INTERRUPT_GRACE,
        "exited {:?} after the interrupt, before the grace period",
        once.after_interrupt
    );
    let twice = interrupted_blocking_call(2);
    assert_eq!(
        (twice.code, twice.stderr.as_str()),
        (Some(exit::CANCELLED), "")
    );
    assert!(
        twice.after_interrupt < INTERRUPT_GRACE,
        "exited {:?} after the second interrupt, not at once",
        twice.after_interrupt
    );
}

#[test]
fn through_the_command_line_that_calls_a_server() {
    let server = Server::start(&[]);
    let command = format!("{} cli-remote {}/cli", fixture().display(), server.url);
    assert_conforms(&["--cli", &command], 20);
}

fn shape(catalog: &Value) -> Value {
    let mark = |items: &Value, schemas: &[&str]| -> Value {
        let items = items.as_object().expect("a map of items");
        items
            .iter()
            .map(|(id, item)| {
                let members = item.as_object().expect("an item is an object");
                let members: Map<String, Value> = members
                    .iter()
                    .map(|(key, value)| {
                        let value = if schemas.contains(&key.as_str()) {
                            Value::Bool(true)
                        } else if key == "failures" {
                            let tags = value.as_object().expect("a map of failures");
                            tags.keys()
                                .map(|tag| (tag.clone(), Value::Bool(true)))
                                .collect()
                        } else {
                            value.clone()
                        };
                        (key.clone(), value)
                    })
                    .collect();
                (id.clone(), Value::Object(members))
            })
            .collect()
    };
    json!({
        "acidcat": catalog["acidcat"],
        "description": catalog["description"],
        "targets": catalog["targets"],
        "capabilities": mark(&catalog["capabilities"], &["input", "output", "state"]),
        "events": mark(&catalog["events"], &["input", "payload"]),
    })
}

#[test]
fn the_fixture_writes_a_catalog_that_conforms_and_agrees_with_the_catalog_of_conform() {
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
    let report: Value =
        serde_json::from_slice(&check.stdout).expect("acid-cat check writes a JSON report");
    assert!(check.status.success(), "acid-cat check: {report:#}");
    assert_eq!(report["conforms"], true, "acid-cat check: {report:#}");

    let catalog: Value = serde_json::from_slice(&output.stdout).expect("the catalog is JSON");
    let conform_catalog: Value = serde_json::from_str(
        &std::fs::read_to_string(
            repository().join("packages/cli/conformance/fixture.acidcat.json"),
        )
        .expect("the catalog of conform"),
    )
    .expect("the catalog of conform is JSON");
    assert_eq!(shape(&catalog), shape(&conform_catalog));
    let input = &catalog["capabilities"]["fixture.note"]["input"];
    assert_eq!(input["$ref"], json!("#/$defs/Note"));
    assert_eq!(input["description"], json!("The note."));
}
