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

#[derive(Clone, Debug)]
pub struct ServerCard {
    /// The name of the card, in reverse-DNS form: 3 to 200 characters, and one `/`, for example
    /// `com.example/aircon`.
    pub name: String,
    /// The description of the card, from 1 to 100 characters. The default is the description of the application.
    pub description: Option<String>,
    /// The `http` or `https` URL of the server in the card. The default is the URL of the request of the card, without
    /// `/server-card`. Give it when a platform in front of the server ends TLS, because the server then gets `http`
    /// requests.
    pub url: Option<String>,
}

impl ServerCard {
    pub fn new(name: impl Into<String>) -> Self {
        ServerCard {
            name: name.into(),
            description: None,
            url: None,
        }
    }
}

pub(crate) struct Card {
    name: String,
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

impl Card {
    pub(crate) fn new(
        card: &ServerCard,
        version: &str,
        app_description: Option<&str>,
        handshake: bool,
        webhooks: Option<&Webhooks>,
    ) -> Self {
        assert!(
            is_card_name(&card.name),
            "the name of the Server Card {:?} must have 3 to 200 characters and the form namespace/name, with the characters a-z, A-Z, 0-9, . and - in the namespace, and a-z, A-Z, 0-9, ., _ and - in the name",
            card.name
        );
        let description = card
            .description
            .as_deref()
            .or(app_description)
            .unwrap_or_default();
        assert!(
            (1..=100).contains(&description.chars().count()),
            "the Server Card needs a description from 1 to 100 characters: give one in the card or in the application"
        );
        assert!(
            version.chars().count() <= 255,
            "the version of a server with a Server Card must have 255 characters or fewer"
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
        if handshake {
            versions.extend(HANDSHAKE_VERSIONS);
        }
        Card {
            name: card.name.clone(),
            version: version.to_owned(),
            description: description.to_owned(),
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
        let mut remote = json!({
            "type": "streamable-http",
            "url": self.url(request),
            "supportedProtocolVersions": self.versions,
        });
        if let Some(webhooks) = &self.webhooks {
            remote["extensionsInfo"] = json!({ EVENTS_EXTENSION: { "webhooks": webhooks } });
        }
        json!({
            "$schema": MCP_SERVER_CARD_SCHEMA,
            "name": self.name,
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
