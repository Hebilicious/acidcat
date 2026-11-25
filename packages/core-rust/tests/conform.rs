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

fn assert_conforms(args: &[&str], minimum: usize) -> Value {
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
    report
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
    let report = assert_conforms(&args, 60);
    let checks = report["checks"].as_array().expect("the report has checks");
    assert!(
        checks
            .iter()
            .any(|check| check["rule"] == "spec/surfaces/mcp.md#server-card"),
        "the default Server Card is checked"
    );
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
    exited_on: String,
}

#[cfg(unix)]
fn wait_for(path: &Path, what: &str) {
    let start = Instant::now();
    while !path.exists() {
        assert!(start.elapsed() < DEADLINE, "the call {what}");
        std::thread::sleep(Duration::from_millis(10));
    }
}

#[cfg(unix)]
fn interrupted_blocking(args: &[&str], interrupts: usize) -> Interrupted {
    let directory = std::env::temp_dir().join(format!(
        "acid-cat-core-rust-interrupt-{}-{}-{interrupts}",
        std::process::id(),
        args[0]
    ));
    std::fs::create_dir_all(&directory).expect("the directory is made");
    let marker = directory.join("held");
    let record = directory.join("exit");
    let mut fixture = Command::new(fixture());
    fixture
        .arg("cli-blocking")
        .args(args)
        .arg("--marker")
        .arg(&marker)
        .env("FIXTURE_EXIT_RECORD", &record)
        .stdout(Stdio::null())
        .stderr(Stdio::piped());
    if interrupts == 2 {
        fixture.env("FIXTURE_HOLD_FIRST_INTERRUPT_UNTIL_SECOND", "1");
    }
    let mut child = fixture.spawn().expect("the fixture starts");
    wait_for(&marker, "did not write its marker file");
    let interrupt = || {
        Command::new("kill")
            .args(["-INT", &child.id().to_string()])
            .status()
            .expect("kill runs");
    };
    let mut interrupted = Instant::now();
    interrupt();
    if interrupts == 2 {
        // The fixture holds the cancellation of the first interrupt until the second interrupt reaches the process, so
        // the grace period cannot start before the second interrupt, however slow the computer.
        wait_for(
            &directory.join("held.cancelled"),
            "did not write its marker file when it was cancelled",
        );
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
    let exited_on = std::fs::read_to_string(&record).unwrap_or_default();
    let _ = std::fs::remove_dir_all(&directory);
    Interrupted {
        code: status.and_then(|status| status.code()),
        stderr,
        after_interrupt: elapsed,
        exited_on,
    }
}

#[cfg(unix)]
fn assert_exits_after_the_grace_period_or_at_once_after_a_second_interrupt(args: &[&str]) {
    let once = interrupted_blocking(args, 1);
    assert_eq!(
        (once.code, once.stderr.as_str(), once.exited_on.is_empty()),
        (Some(exit::CANCELLED), "", false)
    );
    assert!(
        once.after_interrupt >= INTERRUPT_GRACE,
        "exited {:?} after the interrupt, before the grace period",
        once.after_interrupt
    );
    let twice = interrupted_blocking(args, 2);
    assert_eq!(
        (twice.code, twice.stderr.as_str()),
        (Some(exit::CANCELLED), "")
    );
    assert_ne!(
        twice.exited_on, once.exited_on,
        "the process exited on the thread of the grace period, not at the second interrupt"
    );
}

#[cfg(unix)]
#[test]
fn a_call_that_blocks_exits_with_130_after_the_grace_period_or_at_once_after_a_second_interrupt() {
    assert_exits_after_the_grace_period_or_at_once_after_a_second_interrupt(&[
        "fixture", "hold", "--key", "k",
    ]);
}

#[cfg(unix)]
#[test]
fn a_subscription_that_blocks_exits_with_130_after_the_grace_period_or_at_once_after_a_second_interrupt()
 {
    assert_exits_after_the_grace_period_or_at_once_after_a_second_interrupt(&[
        "watch",
        "fixture.watch",
        "--key",
        "k",
    ]);
}

#[cfg(unix)]
#[derive(Debug, PartialEq)]
struct HostExit {
    code: Option<i32>,
    signal: Option<i32>,
    stderr: String,
}

#[cfg(unix)]
fn interrupted_after_the_call(mode: &str) -> HostExit {
    use std::os::unix::process::ExitStatusExt;
    let mut child = Command::new(fixture())
        .args([mode, "fixture", "echo", "--text", "hi"])
        .stdin(Stdio::piped())
        .stdout(Stdio::null())
        .stderr(Stdio::piped())
        .spawn()
        .expect("the fixture starts");
    let (lines, line) = std::sync::mpsc::channel();
    let stderr = BufReader::new(child.stderr.take().expect("standard error"));
    std::thread::spawn(move || {
        for text in stderr.lines().map_while(Result::ok) {
            let _ = lines.send(text);
        }
    });
    let mut written = String::new();
    let mut wait_for = |expected: &str| loop {
        let Ok(text) = line.recv_timeout(DEADLINE) else {
            return false;
        };
        written.push_str(&text);
        written.push('\n');
        if text == expected {
            return true;
        }
    };
    let interrupt = || {
        Command::new("kill")
            .args(["-INT", &child.id().to_string()])
            .status()
            .expect("kill runs");
    };
    let mut ended = false;
    if wait_for("returned") {
        interrupt();
        if mode == "cli-then-host-with-no-handler" {
            drop(child.stdin.take());
            ended = true;
        } else if wait_for("interrupt 1") {
            interrupt();
            if wait_for("interrupt 2") {
                drop(child.stdin.take());
                ended = wait_for("still running");
            }
        }
    }
    if !ended {
        let _ = child.kill();
    }
    let status = child.wait().expect("the status of the fixture");
    while let Ok(text) = line.try_recv() {
        written.push_str(&text);
        written.push('\n');
    }
    HostExit {
        code: status.code(),
        signal: status.signal(),
        stderr: written,
    }
}

#[cfg(unix)]
const HOST_STILL_RUNNING: &str = "returned\ninterrupt 1\ninterrupt 2\nstill running\n";

#[cfg(unix)]
#[test]
fn after_run_cli_process_returns_an_interrupt_does_not_exit_the_process() {
    assert_eq!(
        interrupted_after_the_call("cli-then-host"),
        HostExit {
            code: Some(0),
            signal: None,
            stderr: HOST_STILL_RUNNING.to_owned()
        }
    );
}

#[cfg(unix)]
#[test]
fn after_run_cli_process_returns_an_interrupt_reaches_the_handler_that_the_host_had_before_the_call()
 {
    assert_eq!(
        interrupted_after_the_call("host-then-cli"),
        HostExit {
            code: Some(0),
            signal: None,
            stderr: HOST_STILL_RUNNING.to_owned()
        }
    );
}

#[cfg(unix)]
#[test]
fn after_run_cli_process_returns_an_interrupt_ends_a_host_with_no_handler() {
    assert_eq!(
        interrupted_after_the_call("cli-then-host-with-no-handler"),
        HostExit {
            code: None,
            signal: Some(libc::SIGINT),
            stderr: "returned\n".to_owned()
        }
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
