//! Webhook delivery (spec/bindings/mcp.md#webhook): the server sends the occurrences of each webhook subscription in
//! HTTP `POST` requests to a URL of the client, signed as Standard Webhooks specifies.

use std::collections::{HashMap, HashSet};
use std::fmt;
use std::net::{IpAddr, SocketAddr};
use std::sync::{Arc, Mutex, MutexGuard};
use std::time::{Duration, SystemTime, UNIX_EPOCH};

use base64::Engine;
use base64::engine::general_purpose::{STANDARD, URL_SAFE_NO_PAD};
use bytes::Bytes;
use hmac::{Hmac, Mac};
use http::Uri;
use http_body_util::{BodyExt, Full};
use rand::Rng;
use serde_json::{Map, Value, json};
use sha2::{Digest, Sha256};
use tokio::net::TcpStream;
use tokio::time::Instant;
use tokio_util::sync::CancellationToken;
use tokio_util::task::TaskTracker;

use super::{
    KeyGate, KeyGates, OpenSession, RpcAnswer, RpcError, codes, subscribe_error,
    subscription_params,
};
use crate::schema::canonical_json;
use crate::session::{SubscribeOptions, is_max_age_ms};
use crate::subscription::Occurrences;

/// Tells if a URL is in the allowlist of the deployment.
pub type Allow = Arc<dyn Fn(&Uri) -> bool + Send + Sync>;

/// The settings of webhook delivery. Each limit has the default of spec/bindings/mcp.md#webhook.
#[derive(Clone)]
pub struct WebhookOptions {
    /// The allowlist: a URL for which this function gives `true` gets deliveries with no verification.
    pub allow: Option<Allow>,
    /// Connect also to addresses that are not globally routable, for example `127.0.0.1`. Only for tests and private
    /// deployments. The default is `false`.
    pub allow_private_networks: bool,
    /// Certificates to trust beside the default authorities, in PEM form. A certificate of this list is trusted as
    /// the certificate of an endpoint, also when it is self-signed.
    pub trusted_certificates: Vec<String>,
    /// The maximum lifetime of a subscription. The default is 1 hour.
    pub max_ttl: Duration,
    /// The minimum lifetime of a subscription. The default is 1 minute.
    pub min_ttl: Duration,
    /// The maximum number of webhook subscriptions of one principal. The default is 100.
    pub max_subscriptions: usize,
    /// The maximum number of attempts to send one delivery. The default is 5.
    pub attempts: u32,
    /// The time in which the server makes the attempts of one delivery. The default is 15 minutes.
    pub retry_window: Duration,
    /// The time that the server waits for each answer. The default is 5 seconds.
    pub timeout: Duration,
    /// The time after a change of the secret in which the server signs with the old and the new secret. The default
    /// is 5 minutes.
    pub rotation_grace: Duration,
    /// The wait before the next attempt, after attempt number `attempt` (1 for the first) failed. The default is 10
    /// seconds, multiplied by 3 for each attempt.
    pub retry_delay: Arc<dyn Fn(u32) -> Duration + Send + Sync>,
}

impl Default for WebhookOptions {
    fn default() -> Self {
        WebhookOptions {
            allow: None,
            allow_private_networks: false,
            trusted_certificates: Vec::new(),
            max_ttl: Duration::from_secs(3600),
            min_ttl: Duration::from_secs(60),
            max_subscriptions: 100,
            attempts: 5,
            retry_window: Duration::from_secs(900),
            timeout: Duration::from_secs(5),
            rotation_grace: Duration::from_secs(300),
            retry_delay: Arc::new(|attempt| {
                Duration::from_secs(10 * 3u64.pow(attempt.saturating_sub(1)))
            }),
        }
    }
}

impl fmt::Debug for WebhookOptions {
    fn fmt(&self, formatter: &mut fmt::Formatter<'_>) -> fmt::Result {
        formatter
            .debug_struct("WebhookOptions")
            .field("allow_private_networks", &self.allow_private_networks)
            .field("max_ttl", &self.max_ttl)
            .field("min_ttl", &self.min_ttl)
            .field("max_subscriptions", &self.max_subscriptions)
            .finish_non_exhaustive()
    }
}

/// The category of a failure of a delivery or a verification.
type WebhookError = &'static str;

struct SubscriptionState {
    secret: String,
    /// The secret before the last change, and the time until which the server still signs with it.
    previous: Option<(String, Instant)>,
    expires_at: SystemTime,
    deadline: Instant,
    watermark: Option<String>,
    last_delivery_at: Option<String>,
    last_error: Option<WebhookError>,
}

struct Subscription {
    id: String,
    key: String,
    principal: String,
    url: Uri,
    /// Cancelled when the subscription ends. It stops the deliveries and the waits between attempts.
    ended: CancellationToken,
    state: Mutex<SubscriptionState>,
}

impl Subscription {
    fn lock(&self) -> MutexGuard<'_, SubscriptionState> {
        self.state
            .lock()
            .unwrap_or_else(|poisoned| poisoned.into_inner())
    }

    /// The secrets that sign a delivery now: the new secret, and the old secret during the grace time.
    fn secrets(&self) -> Vec<String> {
        let state = self.lock();
        let mut secrets = vec![state.secret.clone()];
        if let Some((previous, until)) = &state.previous
            && Instant::now() < *until
        {
            secrets.push(previous.clone());
        }
        secrets
    }
}

/// The webhook subscriptions of one server.
pub(crate) struct Webhooks {
    options: WebhookOptions,
    tls: Arc<rustls::ClientConfig>,
    subscriptions: Mutex<HashMap<String, Arc<Subscription>>>,
    /// A lock for each key that starts or renews, so that two requests with the same key do not start two subscriptions.
    starting: KeyGates<tokio::sync::Mutex<()>>,
    /// The pairs of principal and URL that agreed to get deliveries, while the process runs.
    verified: Mutex<HashSet<String>>,
    closed: CancellationToken,
    /// The tasks that send the occurrences of the subscriptions. [`Webhooks::close`] waits for them.
    pumps: TaskTracker,
}

enum Sent {
    Delivered,
    Abandoned,
    Stopped,
}

fn lock<T>(mutex: &Mutex<T>) -> MutexGuard<'_, T> {
    mutex
        .lock()
        .unwrap_or_else(|poisoned| poisoned.into_inner())
}

/// The lifetime that the server grants for `ttlMs`: not more than the maximum and not less than the minimum, and the
/// maximum when the request gives no `ttlMs`. The clamp is in milliseconds, before the conversion to a [`Duration`], so
/// that a very large `ttlMs` such as `1e22` cannot overflow.
fn granted_lifetime(ttl_ms: Option<f64>, min_ttl: Duration, max_ttl: Duration) -> Duration {
    let Some(ttl_ms) = ttl_ms else {
        return max_ttl;
    };
    let min_ms = min_ttl.as_secs_f64() * 1000.0;
    let max_ms = max_ttl.as_secs_f64() * 1000.0;
    Duration::from_secs_f64(ttl_ms.max(min_ms).min(max_ms) / 1000.0)
}

impl Webhooks {
    pub(crate) fn new(options: WebhookOptions) -> Arc<Self> {
        let tls = Arc::new(tls_config(&options.trusted_certificates));
        Arc::new(Webhooks {
            options,
            tls,
            subscriptions: Mutex::new(HashMap::new()),
            starting: Mutex::new(HashMap::new()),
            verified: Mutex::new(HashSet::new()),
            closed: CancellationToken::new(),
            pumps: TaskTracker::new(),
        })
    }

    /// End all webhook subscriptions, and wait until their deliveries stop and their sessions close.
    pub(crate) async fn close(&self) {
        self.closed.cancel();
        let subscriptions: Vec<Arc<Subscription>> = lock(&self.subscriptions)
            .drain()
            .map(|(_, subscription)| subscription)
            .collect();
        subscriptions
            .iter()
            .for_each(|subscription| subscription.ended.cancel());
        self.pumps.close();
        self.pumps.wait().await;
    }

    fn end(&self, subscription: &Arc<Subscription>) {
        subscription.ended.cancel();
        let mut subscriptions = lock(&self.subscriptions);
        if subscriptions
            .get(&subscription.key)
            .is_some_and(|current| Arc::ptr_eq(current, subscription))
        {
            subscriptions.remove(&subscription.key);
        }
    }

    /// Answer `events/subscribe`. The server checked the principal.
    pub(crate) async fn subscribe<C: Send + Sync + 'static>(
        self: &Arc<Self>,
        principal: &str,
        params: &Map<String, Value>,
        open: &OpenSession<C>,
    ) -> RpcAnswer {
        let read = subscription_params(params)?;
        let delivery = params
            .get("delivery")
            .and_then(Value::as_object)
            .filter(|delivery| delivery.get("mode") == Some(&json!("webhook")));
        let Some(delivery) = delivery else {
            return Err(RpcError::invalid_params(
                "delivery must be { mode: \"webhook\", url, secret }.",
            ));
        };
        let raw_url = delivery
            .get("url")
            .and_then(Value::as_str)
            .unwrap_or_default()
            .to_owned();
        let url = raw_url.parse::<Uri>().ok().filter(|url| {
            url.scheme_str() == Some("https") && url.host().is_some_and(|host| !host.is_empty())
        });
        let Some(url) = url else {
            return Err(RpcError::invalid_params(
                "delivery.url must be an https URL.",
            ));
        };
        let secret = delivery
            .get("secret")
            .and_then(Value::as_str)
            .filter(|secret| secret_bytes(secret).is_some());
        let Some(secret) = secret.map(str::to_owned) else {
            return Err(RpcError::invalid_params(
                "delivery.secret must be whsec_ and the base64 of 24 to 64 bytes.",
            ));
        };
        let ttl_ms = match params.get("ttlMs") {
            None | Some(Value::Null) => None,
            Some(value) => match value.as_f64().filter(|ttl| ttl.is_finite() && *ttl >= 0.0) {
                Some(ttl) => Some(ttl),
                None => {
                    return Err(RpcError::invalid_params(
                        "ttlMs must be a number of milliseconds or null.",
                    ));
                }
            },
        };
        // The key has the URL as the client sent it, not the parsed URL.
        let key_value = json!([principal, raw_url, read.name, read.input]);
        let key = canonical_json(&key_value);
        // The gate leaves the map of starting keys when this request ends, with success or failure.
        let gate = KeyGate::enter(&self.starting, &key);
        let _held = gate.lock.lock().await;

        let existing = lock(&self.subscriptions).get(&key).cloned();
        if let Some(subscription) = existing {
            // A subscription with this key exists, so the event exists: an invalid maxAgeMs is the next failure.
            if read.max_age_ms.is_some_and(|value| !is_max_age_ms(value)) {
                return Err(RpcError::invalid_params(
                    "maxAgeMs must be an integer that is 0 or more.",
                ));
            }
            // Renew: a new lifetime and the new secret. The cursor of the request changes nothing.
            {
                let mut state = subscription.lock();
                if state.secret != secret {
                    let old = std::mem::replace(&mut state.secret, secret);
                    state.previous = Some((old, Instant::now() + self.options.rotation_grace));
                }
            }
            self.grant(&subscription, ttl_ms);
            return Ok(result_of(&subscription));
        }

        let count = lock(&self.subscriptions)
            .values()
            .filter(|each| each.principal == principal)
            .count();
        if count >= self.options.max_subscriptions {
            return Err(RpcError::new(
                codes::RESOURCE_EXHAUSTED,
                "Too many webhook subscriptions.",
            )
            .with_data(
                json!({ "limit": "subscriptions", "max": self.options.max_subscriptions }),
            ));
        }
        let digest = Sha256::digest(key.as_bytes());
        let id = format!(
            "sub_{}",
            digest[..8]
                .iter()
                .map(|byte| format!("{byte:02x}"))
                .collect::<String>()
        );
        let session = open();
        let options = SubscribeOptions {
            cursor: read.cursor,
            max_age_ms: read.max_age_ms,
            cancel: CancellationToken::new(),
        };
        let occurrences = match session.subscribe(&read.name, read.input, options) {
            Ok(occurrences) => occurrences,
            Err(failure) => {
                session.close();
                return Err(subscribe_error(&failure));
            }
        };
        let reason = if self.closed.is_cancelled() {
            Some("connection_refused")
        } else {
            self.verify(principal, &raw_url, &url, &id, &secret).await
        };
        if let Some(reason) = reason.or(self.closed.is_cancelled().then_some("connection_refused"))
        {
            drop(occurrences);
            session.close();
            return Err(RpcError::new(
                codes::CALLBACK_ENDPOINT,
                "The callback endpoint did not agree to get deliveries.",
            )
            .with_data(json!({ "reason": reason })));
        }
        let subscription = Arc::new(Subscription {
            id,
            key: key.clone(),
            principal: principal.to_owned(),
            url,
            ended: CancellationToken::new(),
            state: Mutex::new(SubscriptionState {
                secret,
                previous: None,
                expires_at: SystemTime::now(),
                deadline: Instant::now(),
                watermark: None,
                last_delivery_at: None,
                last_error: None,
            }),
        });
        lock(&self.subscriptions).insert(key, subscription.clone());
        self.grant(&subscription, ttl_ms);

        // End the subscription when its lifetime ends with no renewal.
        let (webhooks, timed) = (self.clone(), subscription.clone());
        tokio::spawn(async move {
            loop {
                let deadline = timed.lock().deadline;
                tokio::select! {
                    () = timed.ended.cancelled() => return,
                    () = tokio::time::sleep_until(deadline) => {}
                }
                if timed.lock().deadline <= Instant::now() {
                    return webhooks.end(&timed);
                }
            }
        });
        let (webhooks, pumped) = (self.clone(), subscription.clone());
        self.pumps.spawn(async move {
            webhooks.pump(&pumped, occurrences).await;
            webhooks.end(&pumped);
            session.close();
        });
        Ok(result_of(&subscription))
    }

    /// Answer `events/unsubscribe`. The server checked the principal.
    pub(crate) fn unsubscribe(&self, principal: &str, params: &Map<String, Value>) -> RpcAnswer {
        let name = params.get("name").and_then(Value::as_str);
        let url = params
            .get("delivery")
            .and_then(|delivery| delivery.get("url"))
            .and_then(Value::as_str);
        let (Some(name), Some(url)) = (name, url) else {
            return Err(RpcError::invalid_params(
                "events/unsubscribe needs name and delivery.url.",
            ));
        };
        let input = params
            .get("arguments")
            .cloned()
            .unwrap_or_else(|| json!({}));
        let key = canonical_json(&json!([principal, url, name, input]));
        let Some(subscription) = lock(&self.subscriptions).get(&key).cloned() else {
            return Err(
                RpcError::new(codes::NOT_FOUND, "There is no such subscription.")
                    .with_data(json!({ "kind": "subscription" })),
            );
        };
        self.end(&subscription);
        Ok(Map::new())
    }

    /// Grant a lifetime: `ttlMs`, but not more than the maximum and not less than the minimum.
    fn grant(&self, subscription: &Subscription, ttl_ms: Option<f64>) {
        let lifetime = granted_lifetime(ttl_ms, self.options.min_ttl, self.options.max_ttl);
        let mut state = subscription.lock();
        state.expires_at = SystemTime::now() + lifetime;
        state.deadline = Instant::now() + lifetime;
    }

    /// Send the occurrences of a subscription one at a time, in order, until the subscription ends.
    async fn pump(&self, subscription: &Subscription, mut occurrences: Occurrences) {
        loop {
            let next = tokio::select! {
                () = subscription.ended.cancelled() => return,
                next = occurrences.next() => next,
            };
            match next {
                // Complete: the subscription ends with no message.
                None => return,
                Some(Err(failure)) => {
                    let body = json!({ "type": "terminated", "error": { "code": codes::INTERNAL, "message": failure.message } });
                    self.deliver(
                        subscription,
                        &webhook_id(Some("terminated")),
                        &body.to_string(),
                    )
                    .await;
                    return;
                }
                Some(Ok(occurrence)) => {
                    let watermark = subscription.lock().watermark.clone();
                    if occurrence.truncated {
                        let gap = json!({ "type": "gap", "cursor": watermark });
                        if let Sent::Stopped = self
                            .deliver(subscription, &webhook_id(Some("gap")), &gap.to_string())
                            .await
                        {
                            return;
                        }
                    }
                    let cursor = occurrence.cursor.clone().or(watermark);
                    let mut body = occurrence.to_json_without_truncated();
                    if let Some(object) = body.as_object_mut() {
                        match &cursor {
                            Some(cursor) => object.insert("cursor".into(), json!(cursor)),
                            None => object.remove("cursor"),
                        };
                    }
                    if let Sent::Stopped = self
                        .deliver(subscription, &webhook_id(None), &body.to_string())
                        .await
                    {
                        return;
                    }
                    subscription.lock().watermark = cursor;
                }
            }
        }
    }

    /// Send one delivery, with retries.
    async fn deliver(&self, subscription: &Subscription, webhook_id: &str, body: &str) -> Sent {
        let start = Instant::now();
        let mut attempt = 1;
        loop {
            if subscription.ended.is_cancelled() {
                return Sent::Stopped;
            }
            let headers = headers(&subscription.id, &subscription.secrets(), webhook_id, body);
            let posted = self.post(&subscription.url, &headers, body).await;
            match posted {
                Ok((status, _)) if (200..300).contains(&status) => {
                    let mut state = subscription.lock();
                    state.last_delivery_at =
                        Some(humantime::format_rfc3339_millis(SystemTime::now()).to_string());
                    state.last_error = None;
                    return Sent::Delivered;
                }
                Ok((status, _)) => {
                    subscription.lock().last_error = Some(status_error(status));
                    if status == 410 || status == 413 {
                        return Sent::Abandoned;
                    }
                }
                Err(failure) => subscription.lock().last_error = Some(failure),
            }
            let delay = (self.options.retry_delay)(attempt);
            if attempt >= self.options.attempts
                || start.elapsed() + delay > self.options.retry_window
            {
                return Sent::Abandoned;
            }
            tokio::select! {
                () = subscription.ended.cancelled() => return Sent::Stopped,
                () = tokio::time::sleep(delay) => {}
            }
            attempt += 1;
        }
    }

    /// Verify that the endpoint agrees to get deliveries for this principal. The result is the reason of a failure.
    async fn verify(
        &self,
        principal: &str,
        raw_url: &str,
        url: &Uri,
        id: &str,
        secret: &str,
    ) -> Option<WebhookError> {
        let pair = canonical_json(&json!([principal, raw_url]));
        if lock(&self.verified).contains(&pair)
            || self.options.allow.as_ref().is_some_and(|allow| allow(url))
        {
            return None;
        }
        let challenge = URL_SAFE_NO_PAD.encode(rand::rng().random::<[u8; 24]>());
        let body = json!({ "type": "verification", "challenge": challenge }).to_string();
        let headers = headers(
            id,
            &[secret.to_owned()],
            &webhook_id(Some("verification")),
            &body,
        );
        let (status, text) = match self.post(url, &headers, &body).await {
            Ok(answer) => answer,
            Err(failure) => return Some(failure),
        };
        // A 3xx status is http_4xx for a delivery, but challenge_failed for a verification.
        if (300..400).contains(&status) {
            return Some("challenge_failed");
        }
        if !(200..300).contains(&status) {
            return Some(status_error(status));
        }
        let answered = serde_json::from_str::<Value>(&text).ok().and_then(|value| {
            value
                .get("challenge")
                .and_then(Value::as_str)
                .map(str::to_owned)
        });
        if !answered.is_some_and(|answered| same_text(answered.as_bytes(), challenge.as_bytes())) {
            return Some("challenge_failed");
        }
        lock(&self.verified).insert(pair);
        None
    }

    /// Send one `POST` request, with the time limit of the deployment. The result is the status and the text of the
    /// answer, or the category of the failure.
    async fn post(
        &self,
        url: &Uri,
        headers: &[(String, String)],
        body: &str,
    ) -> Result<(u16, String), WebhookError> {
        match tokio::time::timeout(self.options.timeout, self.send(url, headers, body)).await {
            Ok(result) => result,
            Err(_) => Err("timeout"),
        }
    }

    /// Resolve the host name, connect only to an address that the server accepts, with the host name in the `Host`
    /// header and in TLS. Redirects are not followed.
    async fn send(
        &self,
        url: &Uri,
        headers: &[(String, String)],
        body: &str,
    ) -> Result<(u16, String), WebhookError> {
        let host = url
            .host()
            .unwrap_or_default()
            .trim_start_matches('[')
            .trim_end_matches(']')
            .to_owned();
        let port = url.port_u16().unwrap_or(443);
        let accepts =
            |address: &IpAddr| self.options.allow_private_networks || is_globally_routable(address);
        let address: SocketAddr = match host.parse::<IpAddr>() {
            Ok(ip) if accepts(&ip) => SocketAddr::new(ip, port),
            Ok(_) => return Err("connection_refused"),
            Err(_) => {
                let addresses = tokio::net::lookup_host((host.as_str(), port))
                    .await
                    .map_err(|_| "connection_refused")?;
                addresses
                    .into_iter()
                    .find(|address| accepts(&address.ip()))
                    .ok_or("connection_refused")?
            }
        };
        let stream = TcpStream::connect(address)
            .await
            .map_err(|_| "connection_refused")?;
        let server_name =
            rustls::pki_types::ServerName::try_from(host.clone()).map_err(|_| "tls_error")?;
        let tls = tokio_rustls::TlsConnector::from(self.tls.clone())
            .connect(server_name, stream)
            .await
            .map_err(|_| "tls_error")?;
        let (mut sender, connection) =
            hyper::client::conn::http1::handshake(hyper_util::rt::TokioIo::new(tls))
                .await
                .map_err(|_| "connection_refused")?;
        tokio::spawn(connection);
        let authority = url
            .authority()
            .map(|authority| authority.as_str().to_owned())
            .unwrap_or(host);
        let mut request = http::Request::builder()
            .method("POST")
            .uri(url.path_and_query().map_or("/", |path| path.as_str()))
            .header("Host", authority)
            .header("Content-Length", body.len().to_string());
        for (name, value) in headers {
            request = request.header(name.as_str(), value.as_str());
        }
        let request = request
            .body(Full::new(Bytes::from(body.to_owned())))
            .map_err(|_| "connection_refused")?;
        let answer = sender
            .send_request(request)
            .await
            .map_err(|_| "connection_refused")?;
        let status = answer.status().as_u16();
        // The server reads only the answer to a verification. It reads at most 64 KiB of it.
        let mut text = Vec::new();
        let mut answer_body = answer.into_body();
        while let Some(Ok(frame)) = answer_body.frame().await {
            if let Ok(data) = frame.into_data()
                && text.len() < 65_536
            {
                text.extend_from_slice(&data);
            }
        }
        Ok((status, String::from_utf8_lossy(&text).into_owned()))
    }
}

/// The result of `events/subscribe`.
fn result_of(subscription: &Subscription) -> Map<String, Value> {
    let state = subscription.lock();
    let result = json!({
        "id": subscription.id,
        "refreshBefore": humantime::format_rfc3339_millis(state.expires_at).to_string(),
        "cursor": state.watermark,
        "truncated": false,
        "deliveryStatus": { "active": true, "lastDeliveryAt": state.last_delivery_at, "lastError": state.last_error },
    });
    result.as_object().cloned().unwrap_or_default()
}

/// The headers of a delivery, with a new timestamp and signature.
fn headers(
    subscription_id: &str,
    secrets: &[String],
    webhook_id: &str,
    body: &str,
) -> Vec<(String, String)> {
    let timestamp = SystemTime::now()
        .duration_since(UNIX_EPOCH)
        .map_or(0, |time| time.as_secs());
    let signed = format!("{webhook_id}.{timestamp}.{body}");
    let signatures: Vec<String> = secrets
        .iter()
        .filter_map(|secret| {
            let mut mac = Hmac::<Sha256>::new_from_slice(&secret_bytes(secret)?).ok()?;
            mac.update(signed.as_bytes());
            Some(format!(
                "v1,{}",
                STANDARD.encode(mac.finalize().into_bytes())
            ))
        })
        .collect();
    vec![
        ("Content-Type".into(), "application/json".into()),
        ("webhook-id".into(), webhook_id.into()),
        ("webhook-timestamp".into(), timestamp.to_string()),
        ("webhook-signature".into(), signatures.join(" ")),
        ("X-MCP-Subscription-Id".into(), subscription_id.into()),
    ]
}

/// The bytes of a Standard Webhooks secret: `whsec_` and the base64 of 24 to 64 bytes.
fn secret_bytes(secret: &str) -> Option<Vec<u8>> {
    let bytes = STANDARD.decode(secret.strip_prefix("whsec_")?).ok()?;
    (24..=64).contains(&bytes.len()).then_some(bytes)
}

/// A new `webhook-id`: `msg_` and random letters and digits, or `msg_<type>_` and random letters and digits.
fn webhook_id(control: Option<&str>) -> String {
    const ALPHANUMERIC: &[u8] = b"ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789";
    let mut random = rand::rng();
    let characters: String = (0..24)
        .map(|_| ALPHANUMERIC[random.random_range(0..ALPHANUMERIC.len())] as char)
        .collect();
    match control {
        Some(control) => format!("msg_{control}_{characters}"),
        None => format!("msg_{characters}"),
    }
}

fn status_error(status: u16) -> WebhookError {
    if status >= 500 {
        "http_5xx"
    } else {
        "http_4xx"
    }
}

/// Compare two texts in constant time.
fn same_text(a: &[u8], b: &[u8]) -> bool {
    a.len() == b.len()
        && a.iter()
            .zip(b)
            .fold(0u8, |difference, (x, y)| difference | (x ^ y))
            == 0
}

/// Tell if an IP address is globally routable: not in a special-purpose range of the IANA registries that is not
/// global, for example loopback, private, link-local, shared, documentation or multicast addresses.
fn is_globally_routable(address: &IpAddr) -> bool {
    let global_v4 = |[a, b, c, _]: [u8; 4]| {
        !(a == 0
            || a == 10
            || a == 127
            || (a == 100 && (64..=127).contains(&b))
            || (a == 169 && b == 254)
            || (a == 172 && (16..=31).contains(&b))
            || (a == 192 && b == 0 && (c == 0 || c == 2))
            || (a == 192 && b == 88 && c == 99)
            || (a == 192 && b == 168)
            || (a == 198 && (b == 18 || b == 19))
            || (a == 198 && b == 51 && c == 100)
            || (a == 203 && b == 0 && c == 113)
            || a >= 224)
    };
    match address {
        IpAddr::V4(v4) => global_v4(v4.octets()),
        IpAddr::V6(v6) => {
            if let Some(mapped) = v6.to_ipv4_mapped() {
                return global_v4(mapped.octets());
            }
            let [a, b, c, d, ..] = v6.segments();
            !(v6.is_unspecified()
                || v6.is_loopback()
                || (a == 0x64 && b == 0xff9b)
                || (a == 0x100 && b == 0 && c == 0 && d == 0)
                || (a == 0x2001 && b < 0x200)
                || (a == 0x2001 && b == 0xdb8)
                || a == 0x2002
                || (a == 0x3fff && b < 0x1000)
                || a == 0x5f00)
                && (a & 0xe000) == 0x2000
        }
    }
}

/// The TLS settings of the deliveries: the default authorities, and the trusted certificates of the deployment.
fn tls_config(trusted: &[String]) -> rustls::ClientConfig {
    let provider = Arc::new(rustls::crypto::ring::default_provider());
    let mut roots = rustls::RootCertStore {
        roots: webpki_roots::TLS_SERVER_ROOTS.to_vec(),
    };
    let mut pinned = Vec::new();
    for pem in trusted {
        for certificate in rustls_pemfile::certs(&mut pem.as_bytes()).flatten() {
            let _ = roots.add(certificate.clone());
            pinned.push(certificate);
        }
    }
    let webpki = rustls::client::WebPkiServerVerifier::builder_with_provider(
        Arc::new(roots),
        provider.clone(),
    )
    .build();
    let builder = rustls::ClientConfig::builder_with_provider(provider.clone())
        .with_safe_default_protocol_versions();
    match (webpki, builder) {
        (Ok(webpki), Ok(builder)) => builder
            .dangerous()
            .with_custom_certificate_verifier(Arc::new(Verifier {
                webpki,
                pinned,
                provider,
            }))
            .with_no_client_auth(),
        // The ring provider always has default protocol versions, and the default roots are never empty.
        _ => rustls::ClientConfig::builder_with_provider(provider)
            .with_safe_default_protocol_versions()
            .map(|builder| {
                builder
                    .with_root_certificates(rustls::RootCertStore::empty())
                    .with_no_client_auth()
            })
            .unwrap_or_else(|_| {
                unreachable!("the ring provider supports the default protocol versions")
            }),
    }
}

/// Checks the certificate of an endpoint: a trusted certificate of the deployment, also a self-signed one, or a
/// certificate that the authorities sign. The signatures of the handshake are always checked.
#[derive(Debug)]
struct Verifier {
    webpki: Arc<rustls::client::WebPkiServerVerifier>,
    pinned: Vec<rustls::pki_types::CertificateDer<'static>>,
    provider: Arc<rustls::crypto::CryptoProvider>,
}

impl rustls::client::danger::ServerCertVerifier for Verifier {
    fn verify_server_cert(
        &self,
        end_entity: &rustls::pki_types::CertificateDer<'_>,
        intermediates: &[rustls::pki_types::CertificateDer<'_>],
        server_name: &rustls::pki_types::ServerName<'_>,
        ocsp_response: &[u8],
        now: rustls::pki_types::UnixTime,
    ) -> Result<rustls::client::danger::ServerCertVerified, rustls::Error> {
        if self
            .pinned
            .iter()
            .any(|pinned| pinned.as_ref() == end_entity.as_ref())
        {
            return Ok(rustls::client::danger::ServerCertVerified::assertion());
        }
        self.webpki
            .verify_server_cert(end_entity, intermediates, server_name, ocsp_response, now)
    }

    fn verify_tls12_signature(
        &self,
        message: &[u8],
        certificate: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls12_signature(
            message,
            certificate,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn verify_tls13_signature(
        &self,
        message: &[u8],
        certificate: &rustls::pki_types::CertificateDer<'_>,
        signature: &rustls::DigitallySignedStruct,
    ) -> Result<rustls::client::danger::HandshakeSignatureValid, rustls::Error> {
        rustls::crypto::verify_tls13_signature(
            message,
            certificate,
            signature,
            &self.provider.signature_verification_algorithms,
        )
    }

    fn supported_verify_schemes(&self) -> Vec<rustls::SignatureScheme> {
        self.provider
            .signature_verification_algorithms
            .supported_schemes()
    }
}

#[cfg(test)]
mod tests {
    use super::*;
    use crate::app::{App, Application, Event};
    use crate::session::Session;

    struct Services;

    /// An application with one event that never gives an occurrence.
    fn application() -> Arc<Application<Services>> {
        App::new()
            .title("Test")
            .target("mcp", ["mcp"])
            .event(
                Event::new("test.quiet", "Never give an occurrence.")
                    .audience(["mcp"])
                    .subscribe(|(), _| futures::stream::pending()),
            )
            .build()
            .unwrap_or_else(|problems| panic!("the application does not conform: {problems:?}"))
    }

    fn opener() -> OpenSession<Services> {
        let app = application();
        let context = Arc::new(Services);
        Arc::new(move || Session::open(&app, "mcp", context.clone()))
    }

    /// Webhooks that deliver to every URL with no verification.
    fn webhooks() -> Arc<Webhooks> {
        Webhooks::new(WebhookOptions {
            allow: Some(Arc::new(|_| true)),
            ..WebhookOptions::default()
        })
    }

    fn request(name: &str, ttl_ms: Value) -> Map<String, Value> {
        let secret = format!("whsec_{}", STANDARD.encode([7u8; 32]));
        let params = json!({
            "name": name,
            "delivery": { "mode": "webhook", "url": "https://example.com/hook", "secret": secret },
            "ttlMs": ttl_ms,
        });
        params.as_object().cloned().unwrap_or_default()
    }

    #[test]
    fn the_granted_lifetime_is_clamped_in_milliseconds() {
        let (min, max) = (Duration::from_secs(60), Duration::from_secs(3600));
        assert_eq!(granted_lifetime(Some(1e22), min, max), max);
        assert_eq!(granted_lifetime(Some(f64::MAX), min, max), max);
        assert_eq!(granted_lifetime(Some(0.0), min, max), min);
        assert_eq!(
            granted_lifetime(Some(120_000.0), min, max),
            Duration::from_secs(120)
        );
        assert_eq!(granted_lifetime(None, min, max), max);
    }

    #[tokio::test]
    async fn a_very_large_ttl_gets_the_maximum_lifetime() {
        let webhooks = webhooks();
        let open = opener();
        let result = webhooks
            .subscribe("principal", &request("test.quiet", json!(1e22)), &open)
            .await;
        assert!(result.is_ok(), "the subscription starts: {result:?}");
        let expires_at = lock(&webhooks.subscriptions)
            .values()
            .map(|subscription| subscription.lock().expires_at)
            .next();
        let lifetime = expires_at
            .and_then(|expires_at| expires_at.duration_since(SystemTime::now()).ok())
            .unwrap_or_default();
        assert!(lifetime > Duration::from_secs(3590) && lifetime <= Duration::from_secs(3600));
        webhooks.close().await;
    }

    #[tokio::test]
    async fn the_lock_of_a_key_leaves_the_map_when_the_start_ends() {
        let webhooks = webhooks();
        let open = opener();
        let started = webhooks
            .subscribe("principal", &request("test.quiet", Value::Null), &open)
            .await;
        assert!(started.is_ok(), "the subscription starts: {started:?}");
        assert!(lock(&webhooks.starting).is_empty());

        let failed = webhooks
            .subscribe("principal", &request("test.unknown", Value::Null), &open)
            .await;
        assert!(failed.is_err(), "an unknown event fails");
        assert!(lock(&webhooks.starting).is_empty());
        webhooks.close().await;
    }

    #[tokio::test]
    async fn close_waits_until_the_deliveries_stop() {
        let webhooks = webhooks();
        let open = opener();
        for key in ["a", "b", "c"] {
            let mut params = request("test.quiet", Value::Null);
            if let Some(delivery) = params.get_mut("delivery") {
                delivery["url"] = json!(format!("https://example.com/{key}"));
            }
            let result = webhooks.subscribe("principal", &params, &open).await;
            assert!(result.is_ok(), "the subscription starts: {result:?}");
        }
        assert_eq!(webhooks.pumps.len(), 3);
        webhooks.close().await;
        assert!(
            webhooks.pumps.is_empty(),
            "close returns after each pump ends"
        );
        assert!(lock(&webhooks.subscriptions).is_empty());
    }
}
