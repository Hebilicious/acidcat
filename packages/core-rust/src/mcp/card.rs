use bytes::Bytes;
use http::{HeaderValue, Method, Request, Response, header};
use http_body_util::{BodyExt, Full};
use serde_json::{Value, json};
use sha2::{Digest, Sha256};

use super::webhook::Webhooks;
use super::{EVENTS_EXTENSION, HANDSHAKE_VERSIONS, PROTOCOL_VERSION};
use crate::facts_generated::{
    MCP_SERVER_CARD_CACHE_CONTROL, MCP_SERVER_CARD_MEDIA_TYPE, MCP_SERVER_CARD_PATH,
    MCP_SERVER_CARD_SCHEMA,
};
use crate::remote::{ResponseBody, empty_response, header_text};

/// [`ServerCard::default`] gives the default name and description.
#[derive(Clone, Debug, Default)]
pub struct ServerCard {
    /// The name of the card, in reverse-DNS form: 3 to 200 characters, and one `/`, for example
    /// `com.example/aircon`. The default comes from the host of the URL of the server and the name of the server:
    /// `com.example.aircon/<name>` for `aircon.example.com`.
    pub name: Option<String>,
    /// The description of the card, from 1 to 100 characters. The default is the description of the application,
    /// shortened to 100 characters.
    pub description: Option<String>,
    /// The `http` or `https` URL of the server in the card. The default is the URL of the request of the card, without
    /// `/server-card`. Give it when a platform in front of the server ends TLS, because the server then gets `http`
    /// requests.
    pub url: Option<String>,
}

impl ServerCard {
    /// A card with this name and the other defaults.
    pub fn named(name: impl Into<String>) -> Self {
        ServerCard {
            name: Some(name.into()),
            ..ServerCard::default()
        }
    }
}

pub(crate) struct Card {
    name: Option<String>,
    server_name: String,
    version: String,
    description: String,
    url: Option<String>,
    versions: Vec<&'static str>,
    webhooks: Option<Value>,
}

fn is_card_name(name: &str) -> bool {
    let Some((namespace, short)) = name.split_once('/') else {
        return false;
    };
    (3..=200).contains(&name.chars().count())
        && !namespace.is_empty()
        && namespace
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'-'))
        && !short.is_empty()
        && short
            .bytes()
            .all(|byte| byte.is_ascii_alphanumeric() || matches!(byte, b'.' | b'_' | b'-'))
}

fn is_version_range(version: &str) -> bool {
    let text = version.trim();
    let release = text.split(['-', '+']).next().unwrap_or_default();
    text.starts_with(['^', '~', '<', '>', '='])
        || text.contains("||")
        || text
            .chars()
            .zip(text.chars().skip(1))
            .any(|(before, after)| before.is_whitespace() && after == '-')
        || release
            .split('.')
            .any(|part| matches!(part, "x" | "X" | "*"))
}

const FALLBACK_NAMESPACE: &str = "local";

fn default_name(host: &str, server_name: &str) -> String {
    let server: String = server_name
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '_' | '-' => character,
            _ => '-',
        })
        .take(100)
        .collect();
    let server = if server.is_empty() {
        "mcp".to_owned()
    } else {
        server
    };
    format!("{}/{server}", namespace(host))
}

fn namespace(host: &str) -> String {
    if host.starts_with('[') {
        return FALLBACK_NAMESPACE.to_owned();
    }
    let without_port = match host.rsplit_once(':') {
        Some((name, port)) if port.bytes().all(|byte| byte.is_ascii_digit()) => name,
        _ => host,
    };
    let hostname = without_port
        .strip_suffix('.')
        .unwrap_or(without_port)
        .to_ascii_lowercase();
    let last = hostname.rsplit('.').next().unwrap_or_default();
    if hostname.is_empty() || (!last.is_empty() && last.bytes().all(|byte| byte.is_ascii_digit())) {
        return FALLBACK_NAMESPACE.to_owned();
    }
    let namespace: String = hostname
        .rsplit('.')
        .collect::<Vec<_>>()
        .join(".")
        .chars()
        .map(|character| match character {
            'a'..='z' | 'A'..='Z' | '0'..='9' | '.' | '-' => character,
            _ => '-',
        })
        .collect();
    if namespace.len() > 99 {
        FALLBACK_NAMESPACE.to_owned()
    } else {
        namespace
    }
}

fn default_description(texts: &[Option<&str>]) -> String {
    let text = texts
        .iter()
        .flatten()
        .find(|text| !text.is_empty())
        .copied()
        .unwrap_or("MCP server");
    if text.chars().count() <= 100 {
        text.to_owned()
    } else {
        text.chars().take(99).chain(['…']).collect()
    }
}

fn authority_of(url: &str) -> &str {
    let after_scheme = url.split_once("://").map_or(url, |(_, rest)| rest);
    let authority = after_scheme
        .split(['/', '?', '#'])
        .next()
        .unwrap_or_default();
    authority
        .rsplit_once('@')
        .map_or(authority, |(_, host)| host)
}

pub(crate) struct CardServer<'a> {
    pub(crate) name: &'a str,
    pub(crate) version: &'a str,
    pub(crate) descriptions: [Option<&'a str>; 3],
    pub(crate) handshake: bool,
}

impl Card {
    pub(crate) fn new(card: &ServerCard, server: &CardServer, webhooks: Option<&Webhooks>) -> Self {
        if let Some(name) = &card.name {
            assert!(
                is_card_name(name),
                "the name of the Server Card {name:?} must have 3 to 200 characters and the form namespace/name, with the characters a-z, A-Z, 0-9, . and - in the namespace, and a-z, A-Z, 0-9, ., _ and - in the name"
            );
        }
        if let Some(description) = &card.description {
            assert!(
                (1..=100).contains(&description.chars().count()),
                "the description of the Server Card must have 1 to 100 characters"
            );
        }
        let version = server.version;
        assert!(
            version.chars().count() <= 255,
            "the version of a server with a Server Card must have 255 characters or fewer"
        );
        assert!(
            !is_version_range(version),
            "the version of a server with a Server Card {version:?} must be one version, not a range such as ^1.2.3, >=1.2.3 or 1.x"
        );
        if let Some(url) = &card.url {
            assert!(
                ["http://", "https://"]
                    .iter()
                    .any(|scheme| url.len() > scheme.len() && url.starts_with(scheme))
                    && !url.chars().any(char::is_whitespace),
                "the URL of the Server Card {url:?} must be an http or https URL"
            );
        }
        let mut versions = vec![PROTOCOL_VERSION];
        if server.handshake {
            versions.extend(HANDSHAKE_VERSIONS);
        }
        Card {
            name: card.name.clone(),
            server_name: server.name.to_owned(),
            version: version.to_owned(),
            description: card
                .description
                .clone()
                .unwrap_or_else(|| default_description(&server.descriptions)),
            url: card.url.clone(),
            versions,
            webhooks: webhooks.and_then(Webhooks::card_info),
        }
    }

    pub(crate) fn is_card_request<B>(request: &Request<B>) -> bool {
        request.uri().path().ends_with(MCP_SERVER_CARD_PATH)
    }

    fn url<B>(&self, request: &Request<B>) -> String {
        if let Some(url) = &self.url {
            return url.clone();
        }
        let uri = request.uri();
        let (scheme, authority) = match (uri.scheme_str(), uri.authority()) {
            (Some(scheme), Some(authority)) => (scheme, authority.as_str()),
            _ => (
                "http",
                header_text(request.headers(), header::HOST.as_str()).unwrap_or_default(),
            ),
        };
        let path = uri
            .path()
            .strip_suffix(MCP_SERVER_CARD_PATH)
            .filter(|path| !path.is_empty())
            .unwrap_or("/");
        format!("{scheme}://{authority}{path}")
    }

    fn body<B>(&self, request: &Request<B>) -> String {
        let url = self.url(request);
        let name = self
            .name
            .clone()
            .unwrap_or_else(|| default_name(authority_of(&url), &self.server_name));
        let mut remote = json!({
            "type": "streamable-http",
            "url": url,
            "supportedProtocolVersions": self.versions,
        });
        if let Some(webhooks) = &self.webhooks {
            remote["extensionsInfo"] = json!({ EVENTS_EXTENSION: { "webhooks": webhooks } });
        }
        json!({
            "$schema": MCP_SERVER_CARD_SCHEMA,
            "name": name,
            "version": self.version,
            "description": self.description,
            "remotes": [remote],
        })
        .to_string()
    }

    pub(crate) fn respond<B>(&self, request: &Request<B>) -> Response<ResponseBody> {
        match *request.method() {
            Method::GET => {
                let body = self.body(request);
                let digest = Sha256::digest(body.as_bytes());
                let hex: String = digest[..16]
                    .iter()
                    .map(|byte| format!("{byte:02x}"))
                    .collect();
                let etag = format!("\"{hex}\"");
                let matches = request
                    .headers()
                    .get_all(header::IF_NONE_MATCH)
                    .iter()
                    .filter_map(|value| value.to_str().ok())
                    .flat_map(|value| value.split(','))
                    .any(|tag| tag.trim() == etag || tag.trim() == "*");
                let mut answer = if matches {
                    empty_response(304)
                } else {
                    let mut answer = Response::new(
                        Full::new(Bytes::from(body))
                            .map_err(|never| match never {})
                            .boxed_unsync(),
                    );
                    answer.headers_mut().insert(
                        header::CONTENT_TYPE,
                        HeaderValue::from_static(MCP_SERVER_CARD_MEDIA_TYPE),
                    );
                    answer
                };
                cors(answer.headers_mut());
                if let Ok(etag) = HeaderValue::from_str(&etag) {
                    answer.headers_mut().insert(header::ETAG, etag);
                }
                answer
            }
            Method::OPTIONS => {
                let mut answer = empty_response(204);
                cors(answer.headers_mut());
                answer
            }
            _ => {
                let mut answer = empty_response(405);
                answer
                    .headers_mut()
                    .insert(header::ALLOW, HeaderValue::from_static("GET, OPTIONS"));
                answer
            }
        }
    }
}

fn cors(headers: &mut http::HeaderMap) {
    for (name, value) in [
        (header::ACCESS_CONTROL_ALLOW_ORIGIN, "*"),
        (header::ACCESS_CONTROL_ALLOW_METHODS, "GET"),
        (
            header::ACCESS_CONTROL_ALLOW_HEADERS,
            "Content-Type, If-None-Match",
        ),
        (header::ACCESS_CONTROL_EXPOSE_HEADERS, "ETag"),
        (header::CACHE_CONTROL, MCP_SERVER_CARD_CACHE_CONTROL),
    ] {
        headers.insert(name, HeaderValue::from_static(value));
    }
}

#[cfg(test)]
mod tests {
    use super::{default_description, default_name, is_version_range};

    #[test]
    fn the_default_name_reverses_the_labels_of_the_host_and_falls_back_to_local_for_an_ip_address()
    {
        let long_host = format!("{}.com", "a".repeat(100));
        let long_name = "n".repeat(150);
        let cases = [
            (
                "aircon.example.com",
                "aircon",
                "com.example.aircon/aircon".to_owned(),
            ),
            (
                "Aircon.Example.COM.",
                "aircon",
                "com.example.aircon/aircon".to_owned(),
            ),
            (
                "aircon.example.com:8443",
                "aircon",
                "com.example.aircon/aircon".to_owned(),
            ),
            ("localhost", "aircon", "localhost/aircon".to_owned()),
            ("localhost:3000", "aircon", "localhost/aircon".to_owned()),
            ("127.0.0.1:3000", "aircon", "local/aircon".to_owned()),
            ("[::1]:3000", "aircon", "local/aircon".to_owned()),
            ("[2001:db8::1]", "aircon", "local/aircon".to_owned()),
            ("", "aircon", "local/aircon".to_owned()),
            (
                "my_host.example.com",
                "air con/é🙂",
                "com.example.my-host/air-con---".to_owned(),
            ),
            ("example.com", "", "com.example/mcp".to_owned()),
            (long_host.as_str(), "aircon", "local/aircon".to_owned()),
            (
                "example.com",
                long_name.as_str(),
                format!("com.example/{}", "n".repeat(100)),
            ),
        ];
        for (host, name, expected) in cases {
            assert_eq!(default_name(host, name), expected, "{host} {name}");
        }
    }

    #[test]
    fn the_default_description_is_the_first_text_that_is_not_empty_shortened_to_100_characters() {
        assert_eq!(
            default_description(&[
                Some("The catalog."),
                Some("The instructions."),
                Some("aircon")
            ]),
            "The catalog."
        );
        assert_eq!(
            default_description(&[None, Some(""), Some("The instructions."), Some("aircon")]),
            "The instructions."
        );
        assert_eq!(default_description(&[None, None, Some("aircon")]), "aircon");
        assert_eq!(default_description(&[None, Some("")]), "MCP server");
        let hundred = "é".repeat(100);
        assert_eq!(default_description(&[Some(hundred.as_str())]), hundred);
        let long = "🙂".repeat(101);
        assert_eq!(
            default_description(&[Some(long.as_str())]),
            format!("{}…", "🙂".repeat(99))
        );
    }

    #[test]
    fn a_version_range_is_not_a_version() {
        for range in [
            "^1.2.3",
            "~1.2.3",
            ">=1.2.3",
            "<2",
            "=1.0.0",
            "1.x",
            "1.2.*",
            "*",
            "1 - 2",
            "1.2 || 1.3",
        ] {
            assert!(is_version_range(range), "{range}");
        }
        for version in [
            "1.2.3",
            "2.1.0-alpha",
            "1.0.0-next.1",
            "1.0.0+x",
            "0.0.0",
            "v1.2",
        ] {
            assert!(!is_version_range(version), "{version}");
        }
    }
}
